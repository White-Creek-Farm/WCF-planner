-- ============================================================================
-- 176_processing_lifecycle_reconcile.sql
-- Processing planner integration — checkpoint 2 of 3 (lifecycle + reconcile +
-- transactional Pig planner mutations). Builds on 175's additive foundation.
--
-- 1. Processing-owned lifecycle status. Stored processing_records.status is
--    normalized to exactly planned | in_process | complete and the planner
--    reconcile STOPS copying native source statuses. Effective status is
--    derived at read time in America/Chicago:
--      • completed_at (explicit completion) -> Complete
--      • pig actual trip (source_phase='actual') -> In Process even when the
--        source date moved into the future
--      • processing_date has begun (<= today, farm timezone) -> In Process
--      • otherwise -> Planned
--    Milestones keep their explicitly chosen status.
-- 2. Completion blockers reissue: date must have BEGUN (Chicago), processor
--    selected, live source Count > 0, and every subtask completed or removed.
--    Customer and missing weights never block. mark_processing_complete stamps
--    completed_by.
-- 3. Normalized live source projection: list/get join the live planner sources
--    (ppp-v4 by immutable batch id, cattle/sheep batch tables, ppp-feeders
--    trips) and return a `source` object + `effective_status` + `search_text`
--    per row, so the UI never renders stale Processing snapshots. get returns
--    per-animal detail for cattle/sheep (live tag, DOB, age at processing,
--    retag-aware latest live weight, hanging weight) and linked weigh-in
--    weights for pig actual trips (tagless -> client labels Pig 1..N).
-- 4. Planner reconcile reissue:
--      • broiler enumerates by immutable batch.id (175 rekeyed existing rows)
--        and only when a processingDate exists;
--      • cattle/sheep only when a processing date (actual or planned) exists;
--      • pig enumerates BOTH plannedProcessingTrips and actual processingTrips
--        (same groupId:tripId identity — promotion keeps the record);
--      • the sweep applies empty-remove vs worked-archive: an untouched
--        auto-created row whose source disappeared is DELETED, a worked row is
--        archived + stamped source_removed_at (dormant) and restores with the
--        same identity when its source returns.
-- 5. Database-owned transactional Pig mutations: planned add/move/delete/date,
--    send, undo-send, actual-trip edit/delete. Each locks the ppp-feeders-v1
--    app_store row (FOR UPDATE) and the touched weigh_ins rows in ONE
--    transaction, performs targeted JSON surgery preserving unrelated fields,
--    and re-syncs that group's Processing records — no client dual-writes.
--    Fulfillment PROMOTES the planned trip id into processingTrips unchanged,
--    so groupId:tripId (and the Processing record) survives promotion.
--    Under-send moves the remainder to the next planned trip or a NEW planned
--    trip id; over-send consumes later planned trips deterministically in
--    chain order; undo returns counts to the plan (an emptied actual trip
--    reverts to a planned trip with the SAME id); actual-trip delete clears
--    dangling weigh-in stamps.
--
-- RLS posture unchanged (deny-all + SECURITY DEFINER). All functions SET
-- search_path = public. NOTIFY pgrst at the end (read shapes changed).
-- ============================================================================

-- ── 1. One-time status vocabulary normalization ─────────────────────────────
-- Planner rows: status is Processing-owned from now on. Only an explicit
-- completion means complete; everything else derives at read time.
UPDATE public.processing_records
   SET status = CASE WHEN completed_at IS NOT NULL THEN 'complete' ELSE 'planned' END
 WHERE record_type = 'planner_batch'
   AND status NOT IN ('planned', 'in_process', 'complete');

-- Imported/historical + milestone rows: map legacy source vocabulary onto the
-- Processing set (same mapping as src/lib/processingStatusDisplay.js). Rows
-- that read as complete keep reading complete: stamp completed_at from the
-- best available historical timestamp so the derived status stays Complete.
UPDATE public.processing_records
   SET status = CASE
                  WHEN lower(btrim(status)) IN ('complete','completed','processed','done') THEN 'complete'
                  WHEN lower(btrim(status)) IN ('active','in_process','in-process','in process','processing',
                                                'in-proccess','in proccess','in_proccess') THEN 'in_process'
                  ELSE 'planned'
                END,
       completed_at = CASE
                        WHEN lower(btrim(status)) IN ('complete','completed','processed','done')
                        THEN COALESCE(completed_at,
                                      (processing_date::timestamptz + interval '12 hours'),
                                      created_at)
                        ELSE completed_at
                      END
 WHERE record_type IN ('asana_historical', 'import_exception', 'milestone')
   AND status NOT IN ('planned', 'in_process', 'complete');

-- ── 2. Farm-timezone helper ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._processing_today_chicago()
RETURNS date
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE
AS $fn$ SELECT (now() AT TIME ZONE 'America/Chicago')::date $fn$;
REVOKE ALL ON FUNCTION public._processing_today_chicago() FROM PUBLIC, anon, authenticated;

-- ── 3. Effective lifecycle status (derived, never stored) ───────────────────
CREATE OR REPLACE FUNCTION public._processing_effective_status(p_rec public.processing_records)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE
AS $fn$
BEGIN
  IF p_rec.record_type = 'milestone' THEN
    RETURN CASE WHEN p_rec.status IN ('planned','in_process','complete') THEN p_rec.status ELSE 'planned' END;
  END IF;
  IF p_rec.completed_at IS NOT NULL OR p_rec.status = 'complete' THEN
    RETURN 'complete';
  END IF;
  -- An actual pig trip already happened: In Process regardless of its date.
  IF p_rec.source_kind = 'pig' AND p_rec.source_phase = 'actual' THEN
    RETURN 'in_process';
  END IF;
  IF p_rec.processing_date IS NOT NULL
     AND p_rec.processing_date <= public._processing_today_chicago() THEN
    RETURN 'in_process';
  END IF;
  RETURN 'planned';
END
$fn$;
REVOKE ALL ON FUNCTION public._processing_effective_status(public.processing_records) FROM PUBLIC, anon, authenticated;

-- ── 4. Live source count (completion gate + projection) ─────────────────────
CREATE OR REPLACE FUNCTION public._processing_live_source_count(p_rec public.processing_records)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE
AS $fn$
DECLARE
  v_count integer;
  v_group jsonb;
  v_trip  jsonb;
BEGIN
  IF p_rec.source_kind IS NULL OR p_rec.source_id IS NULL THEN
    RETURN p_rec.number_processed;
  END IF;
  IF p_rec.source_kind = 'cattle' THEN
    SELECT jsonb_array_length(COALESCE(cows_detail, '[]'::jsonb)) INTO v_count
      FROM public.cattle_processing_batches WHERE id = p_rec.source_id;
    RETURN COALESCE(v_count, p_rec.number_processed);
  ELSIF p_rec.source_kind = 'sheep' THEN
    SELECT jsonb_array_length(COALESCE(sheep_detail, '[]'::jsonb)) INTO v_count
      FROM public.sheep_processing_batches WHERE id = p_rec.source_id;
    RETURN COALESCE(v_count, p_rec.number_processed);
  ELSIF p_rec.source_kind = 'broiler' THEN
    SELECT NULLIF(btrim(COALESCE(b.value->>'totalToProcessor', b.value->>'total_to_processor', '')), '')::int
      INTO v_count
      FROM jsonb_array_elements(
             COALESCE((SELECT data FROM public.app_store WHERE key = 'ppp-v4'), '[]'::jsonb)) AS b
     WHERE COALESCE(btrim(b.value->>'id'), '') = p_rec.source_id
     LIMIT 1;
    RETURN COALESCE(v_count, p_rec.number_processed);
  ELSIF p_rec.source_kind = 'pig' THEN
    SELECT g.value INTO v_group
      FROM jsonb_array_elements(
             COALESCE((SELECT data FROM public.app_store WHERE key = 'ppp-feeders-v1'), '[]'::jsonb)) AS g
     WHERE COALESCE(btrim(g.value->>'id'), '') = split_part(p_rec.source_id, ':', 1)
     LIMIT 1;
    IF v_group IS NULL THEN RETURN p_rec.number_processed; END IF;
    SELECT t.value INTO v_trip
      FROM jsonb_array_elements(COALESCE(v_group->'processingTrips', '[]'::jsonb)) AS t
     WHERE COALESCE(btrim(t.value->>'id'), '') = split_part(p_rec.source_id, ':', 2)
     LIMIT 1;
    IF v_trip IS NOT NULL THEN
      RETURN COALESCE(NULLIF(btrim(COALESCE(v_trip->>'pigCount','')), '')::int, p_rec.number_processed);
    END IF;
    SELECT t.value INTO v_trip
      FROM jsonb_array_elements(COALESCE(v_group->'plannedProcessingTrips', '[]'::jsonb)) AS t
     WHERE COALESCE(btrim(t.value->>'id'), '') = split_part(p_rec.source_id, ':', 2)
     LIMIT 1;
    IF v_trip IS NOT NULL THEN
      RETURN COALESCE(NULLIF(btrim(COALESCE(v_trip->>'plannedCount','')), '')::int, p_rec.number_processed);
    END IF;
    RETURN p_rec.number_processed;
  END IF;
  RETURN p_rec.number_processed;
END
$fn$;
REVOKE ALL ON FUNCTION public._processing_live_source_count(public.processing_records) FROM PUBLIC, anon, authenticated;

-- ── 5. Completion gate reissue (156 base) ───────────────────────────────────
-- Adds: the processing date must have BEGUN in the farm timezone, and the live
-- source Count must be > 0. Customer and missing weights never block.
CREATE OR REPLACE FUNCTION public._processing_completion_blockers(p_id text)
RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE
AS $fn$
DECLARE
  v_rec       public.processing_records;
  v_blockers  text[] := ARRAY[]::text[];
  v_open_subs int;
  v_count     integer;
BEGIN
  SELECT * INTO v_rec FROM public.processing_records WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN ARRAY['record not found'];
  END IF;
  IF v_rec.record_type = 'milestone' THEN
    IF v_rec.processing_date IS NULL THEN
      v_blockers := array_append(v_blockers, 'Processing Date is required');
    END IF;
    RETURN v_blockers;
  END IF;
  IF v_rec.processing_date IS NULL THEN
    v_blockers := array_append(v_blockers, 'Processing Date is required');
  ELSIF v_rec.processing_date > public._processing_today_chicago() THEN
    v_blockers := array_append(v_blockers, 'Processing Date has not begun');
  END IF;
  IF v_rec.processor IS NULL OR btrim(v_rec.processor) = '' THEN
    v_blockers := array_append(v_blockers, 'Processor is required');
  END IF;
  v_count := public._processing_live_source_count(v_rec);
  IF v_count IS NULL OR v_count <= 0 THEN
    v_blockers := array_append(v_blockers, 'Count must be greater than zero');
  END IF;
  SELECT count(*) INTO v_open_subs
    FROM public.processing_subtasks WHERE record_id = p_id AND done = false;
  IF v_open_subs > 0 THEN
    v_blockers := array_append(v_blockers, v_open_subs || ' subtask(s) still open');
  END IF;
  RETURN v_blockers;
END
$fn$;
REVOKE ALL ON FUNCTION public._processing_completion_blockers(text) FROM PUBLIC, anon, authenticated;

-- mark/reopen (164 base): stamp/clear completed_by.
CREATE OR REPLACE FUNCTION public.mark_processing_complete(p_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_blockers text[];
BEGIN
  PERFORM public._processing_require_operational();
  IF NOT EXISTS (SELECT 1 FROM public.processing_records WHERE id = p_id) THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: record not found';
  END IF;
  v_blockers := public._processing_completion_blockers(p_id);
  IF array_length(v_blockers, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: cannot complete — %', array_to_string(v_blockers, '; ');
  END IF;
  UPDATE public.processing_records
     SET status = 'complete', completed_at = now(), completed_by = auth.uid(),
         workflow_touched_at = now(), updated_at = now()
   WHERE id = p_id;
  PERFORM public._processing_emit_activity(
    p_id, 'status.changed', 'Marked complete',
    jsonb_build_object('action', 'mark_complete'));
  RETURN jsonb_build_object('id', p_id, 'ok', true, 'status', 'complete');
END
$fn$;
REVOKE ALL ON FUNCTION public.mark_processing_complete(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_processing_complete(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.reopen_processing_record(p_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
BEGIN
  PERFORM public._processing_require_operational();
  IF NOT EXISTS (SELECT 1 FROM public.processing_records WHERE id = p_id) THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: record not found';
  END IF;
  UPDATE public.processing_records
     SET status = 'planned', completed_at = NULL, completed_by = NULL,
         workflow_touched_at = now(), updated_at = now()
   WHERE id = p_id;
  PERFORM public._processing_emit_activity(
    p_id, 'status.changed', 'Reopened',
    jsonb_build_object('action', 'reopen'));
  RETURN jsonb_build_object('id', p_id, 'ok', true, 'status', 'planned');
END
$fn$;
REVOKE ALL ON FUNCTION public.reopen_processing_record(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reopen_processing_record(text) TO authenticated;

-- ── 6. Planner upsert reissue (164 base) ────────────────────────────────────
-- Deltas:
--   • Planner rows no longer copy source status. INSERTs start 'planned';
--     UPDATEs never touch status/completed_at (Processing-owned).
--   • source_phase ('planned'/'actual', pig) is planner-owned; a phase change
--     appends a 'promoted'/'unpromoted' lineage entry.
--   • Pig rows get a deterministic per-group trip_ordinal (max+1, archived
--     rows included) at INSERT and a 'Pig Trip · <batch> · Trip <n>' title
--     built from the payload's pig_batch_name.
--   • A dormant row whose source returns un-archives, clears
--     source_removed_at, and appends a 'restored' lineage entry.
--   • Template checklist seeding stamps template_step_id from the step's
--     stable id (175).
CREATE OR REPLACE FUNCTION public.upsert_processing_from_planner(p_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_kind    text := p_row->>'source_kind';
  v_sid     text := p_row->>'source_id';
  v_id      text;
  v_old     public.processing_records;
  v_tpl     public.processing_templates;
  v_step    jsonb;
  v_label   text;
  v_pid     uuid;
  v_next    int := 0;
  v_phase   text := NULLIF(btrim(COALESCE(p_row->>'source_phase', '')), '');
  v_ordinal integer;
  v_title   text;
  v_lineage jsonb;
BEGIN
  IF v_kind IS NULL OR v_sid IS NULL OR btrim(v_sid) = '' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: source_kind + source_id required';
  END IF;
  IF v_kind = 'pig' AND v_phase IS NULL THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: pig planner rows require source_phase';
  END IF;

  SELECT * INTO v_old FROM public.processing_records
   WHERE source_kind = v_kind AND source_id = v_sid;

  IF FOUND THEN
    v_id := v_old.id;
    v_title := COALESCE(p_row->>'title', v_old.title);
    IF v_kind = 'pig' AND NULLIF(btrim(COALESCE(p_row->>'pig_batch_name','')), '') IS NOT NULL THEN
      v_title := 'Pig Trip · ' || btrim(p_row->>'pig_batch_name') || ' · Trip ' || COALESCE(v_old.trip_ordinal, 0);
    END IF;

    v_lineage := v_old.lineage;
    IF v_old.archived AND v_old.source_removed_at IS NOT NULL THEN
      v_lineage := v_lineage || jsonb_build_array(jsonb_build_object(
        'event', 'restored', 'at', now(), 'source_id', v_sid));
    END IF;
    IF v_kind = 'pig' AND v_phase IS DISTINCT FROM v_old.source_phase THEN
      v_lineage := v_lineage || jsonb_build_array(jsonb_build_object(
        'event', CASE WHEN v_phase = 'actual' THEN 'promoted' ELSE 'unpromoted' END,
        'at', now(), 'source_id', v_sid));
    END IF;

    UPDATE public.processing_records SET
      record_type           = 'planner_batch',
      program               = COALESCE(p_row->>'program', program),
      title                 = v_title,
      processing_date       = COALESCE((p_row->>'processing_date')::date, processing_date),
      number_processed      = COALESCE((p_row->>'number_processed')::int, number_processed),
      sub_batch_attribution = COALESCE(p_row->'sub_batch_attribution', sub_batch_attribution),
      source_phase          = CASE WHEN v_kind = 'pig' THEN v_phase ELSE source_phase END,
      match_status          = CASE WHEN match_status = 'native' THEN 'native' ELSE match_status END,
      archived              = false,
      source_removed_at     = NULL,
      lineage               = v_lineage,
      sync_run_id           = COALESCE(p_row->>'sync_run_id', sync_run_id),
      last_synced_at        = now(),
      updated_at            = now()
    WHERE id = v_id;
    RETURN jsonb_build_object('id', v_id, 'action', 'updated');
  END IF;

  v_id := 'prc-' || gen_random_uuid()::text;
  IF v_kind = 'pig' THEN
    SELECT COALESCE(max(trip_ordinal), 0) + 1 INTO v_ordinal
      FROM public.processing_records
     WHERE source_kind = 'pig'
       AND source_id LIKE split_part(v_sid, ':', 1) || ':%';
    v_title := 'Pig Trip · ' ||
               COALESCE(NULLIF(btrim(COALESCE(p_row->>'pig_batch_name','')), ''), split_part(v_sid, ':', 1)) ||
               ' · Trip ' || v_ordinal;
  ELSE
    v_title := COALESCE(p_row->>'title', v_sid);
  END IF;

  INSERT INTO public.processing_records
    (id, record_type, program, title, processing_date, status, number_processed,
     source_kind, source_id, source_phase, trip_ordinal, sub_batch_attribution,
     match_status, sync_run_id, last_synced_at, created_by)
  VALUES (
    v_id, 'planner_batch', COALESCE(p_row->>'program', 'broiler'),
    v_title, (p_row->>'processing_date')::date,
    'planned', (p_row->>'number_processed')::int,
    v_kind, v_sid, CASE WHEN v_kind = 'pig' THEN v_phase ELSE NULL END, v_ordinal,
    COALESCE(p_row->'sub_batch_attribution', '[]'::jsonb),
    'native', p_row->>'sync_run_id', now(), public._processing_import_actor()
  );

  -- One-time checklist seed from the ACTIVE template (insert branch only),
  -- carrying the stable template step id.
  SELECT * INTO v_tpl FROM public.processing_templates
   WHERE program = COALESCE(p_row->>'program', 'broiler') AND is_active = true;
  IF FOUND THEN
    FOR v_step IN SELECT * FROM jsonb_array_elements(COALESCE(v_tpl.checklist, '[]'::jsonb))
    LOOP
      v_label := btrim(COALESCE(v_step->>'label', ''));
      CONTINUE WHEN v_label = '';
      v_pid := NULL;
      IF v_step->>'assignee_profile_id' ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'
         AND EXISTS (SELECT 1 FROM public.profiles WHERE id = (v_step->>'assignee_profile_id')::uuid) THEN
        v_pid := (v_step->>'assignee_profile_id')::uuid;
      END IF;
      v_next := v_next + 1;
      INSERT INTO public.processing_subtasks
        (id, record_id, label, assignee, assignee_profile_id, template_step_id, sort_order, created_by)
      VALUES ('pst-' || gen_random_uuid()::text, v_id, v_label,
              CASE WHEN v_pid IS NULL THEN v_step->>'assignee' ELSE NULL END, v_pid,
              NULLIF(btrim(COALESCE(v_step->>'id', '')), ''), v_next,
              public._processing_import_actor());
    END LOOP;
    UPDATE public.processing_records SET template_version = v_tpl.version WHERE id = v_id;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'action', 'inserted');
END
$fn$;
REVOKE ALL ON FUNCTION public.upsert_processing_from_planner(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_processing_from_planner(jsonb) TO service_role;

-- ── 7. Sweep helper: empty-remove vs worked-archive ─────────────────────────
-- Applies the locked source-removal rule to planner rows NOT restamped by the
-- caller's run: a worked row goes dormant (archived + source_removed_at), an
-- untouched auto-created row is deleted outright. p_source_prefix scopes the
-- sweep (NULL = all planner rows; 'pig:<groupId>:' = one pig group).
CREATE OR REPLACE FUNCTION public._processing_sweep_stale_planner_rows(p_run text, p_kind text DEFAULT NULL, p_source_prefix text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_rec RECORD;
  v_archived int := 0;
  v_deleted  int := 0;
BEGIN
  FOR v_rec IN
    SELECT id FROM public.processing_records
     WHERE record_type = 'planner_batch'
       AND archived = false
       AND sync_run_id IS DISTINCT FROM p_run
       AND (p_kind IS NULL OR source_kind = p_kind)
       AND (p_source_prefix IS NULL OR source_id LIKE p_source_prefix || '%')
  LOOP
    IF public._processing_record_worked(v_rec.id) THEN
      UPDATE public.processing_records
         SET archived = true, source_removed_at = now(), updated_at = now(),
             lineage = lineage || jsonb_build_array(jsonb_build_object(
               'event', 'source_removed', 'at', now()))
       WHERE id = v_rec.id;
      v_archived := v_archived + 1;
    ELSE
      DELETE FROM public.processing_records WHERE id = v_rec.id;
      v_deleted := v_deleted + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('archived', v_archived, 'deleted', v_deleted);
END
$fn$;
REVOKE ALL ON FUNCTION public._processing_sweep_stale_planner_rows(text, text, text) FROM PUBLIC, anon, authenticated;

-- ── 8. Reconcile reissue (164 base) ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reconcile_planner_to_processing()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_role text;
  v_run  text := 'reconcile-' || gen_random_uuid()::text;
  v_cattle int := 0; v_sheep int := 0; v_broiler int := 0; v_pig int := 0;
  v_c record; v_s record; v_b jsonb; v_g jsonb; v_t jsonb;
  v_sub_name text;
  v_swept jsonb;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    v_role := public.profile_role();
    IF v_role IS NULL OR v_role NOT IN ('farm_team','management','admin') THEN
      RAISE EXCEPTION 'PROCESSING_VALIDATION: caller role % cannot reconcile', COALESCE(v_role,'null');
    END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('processing_reconcile'));

  -- A record exists only when its source has a processing date.
  FOR v_c IN SELECT id, name, actual_process_date, planned_process_date, cows_detail
               FROM public.cattle_processing_batches
              WHERE COALESCE(actual_process_date, planned_process_date) IS NOT NULL LOOP
    PERFORM public.upsert_processing_from_planner(jsonb_build_object(
      'source_kind','cattle','source_id', v_c.id, 'program','cattle',
      'title', COALESCE(v_c.name, v_c.id),
      'processing_date', COALESCE(v_c.actual_process_date, v_c.planned_process_date),
      'sync_run_id', v_run,
      'number_processed', jsonb_array_length(COALESCE(v_c.cows_detail, '[]'::jsonb))));
    v_cattle := v_cattle + 1;
  END LOOP;

  FOR v_s IN SELECT id, name, actual_process_date, planned_process_date, sheep_detail
               FROM public.sheep_processing_batches
              WHERE COALESCE(actual_process_date, planned_process_date) IS NOT NULL LOOP
    PERFORM public.upsert_processing_from_planner(jsonb_build_object(
      'source_kind','sheep','source_id', v_s.id, 'program','sheep',
      'title', COALESCE(v_s.name, v_s.id),
      'processing_date', COALESCE(v_s.actual_process_date, v_s.planned_process_date),
      'sync_run_id', v_run,
      'number_processed', jsonb_array_length(COALESCE(v_s.sheep_detail, '[]'::jsonb))));
    v_sheep := v_sheep + 1;
  END LOOP;

  -- Broiler: immutable batch.id is the identity; the mutable name is title.
  FOR v_b IN SELECT value FROM jsonb_array_elements(
               COALESCE((SELECT data FROM public.app_store WHERE key = 'ppp-v4'), '[]'::jsonb)) AS t(value) LOOP
    CONTINUE WHEN COALESCE(NULLIF(btrim(COALESCE(v_b->>'processingDate', v_b->>'processing_date', '')), ''), NULL) IS NULL;
    CONTINUE WHEN COALESCE(btrim(COALESCE(v_b->>'id','')), '') = '';
    PERFORM public.upsert_processing_from_planner(jsonb_build_object(
      'source_kind','broiler','source_id', btrim(v_b->>'id'), 'program','broiler',
      'title', COALESCE(NULLIF(btrim(COALESCE(v_b->>'name','')), ''), btrim(v_b->>'id')),
      'processing_date', COALESCE(v_b->>'processingDate', v_b->>'processing_date'),
      'sync_run_id', v_run,
      'number_processed', COALESCE(v_b->>'totalToProcessor', v_b->>'total_to_processor')));
    v_broiler := v_broiler + 1;
  END LOOP;

  -- Pig: EVERY persisted planned trip projects a Planned record; every actual
  -- trip an actual one. Same groupId:tripId namespace — promotion keeps the
  -- record. When a trip id somehow appears in both arrays, actual wins
  -- (enumerated second, restamps the same row).
  FOR v_g IN SELECT value FROM jsonb_array_elements(
               COALESCE((SELECT data FROM public.app_store WHERE key = 'ppp-feeders-v1'), '[]'::jsonb)) AS t(value) LOOP
    FOR v_t IN SELECT value FROM jsonb_array_elements(COALESCE(v_g->'plannedProcessingTrips', '[]'::jsonb)) AS t(value) LOOP
      CONTINUE WHEN COALESCE(btrim(COALESCE(v_t->>'id','')), '') = '';
      SELECT sb.value->>'name' INTO v_sub_name
        FROM jsonb_array_elements(COALESCE(v_g->'subBatches', '[]'::jsonb)) AS sb
       WHERE COALESCE(btrim(sb.value->>'id'), '') = COALESCE(btrim(v_t->>'subBatchId'), '')
       LIMIT 1;
      PERFORM public.upsert_processing_from_planner(jsonb_build_object(
        'source_kind','pig',
        'source_id', (v_g->>'id') || ':' || (v_t->>'id'),
        'program','pig',
        'pig_batch_name', COALESCE(v_g->>'batchName', v_g->>'id'),
        'processing_date', v_t->>'date',
        'source_phase', 'planned',
        'sync_run_id', v_run,
        'number_processed', v_t->>'plannedCount',
        'sub_batch_attribution', jsonb_build_array(jsonb_build_object(
          'subId', v_t->>'subBatchId',
          'subBatchName', COALESCE(v_sub_name, v_t->>'subBatchId'),
          'sex', CASE WHEN v_t->>'sex' = 'boar' THEN 'Boars' ELSE 'Gilts' END,
          'count', COALESCE(NULLIF(btrim(COALESCE(v_t->>'plannedCount','')), '')::int, 0)))));
      v_pig := v_pig + 1;
    END LOOP;
    FOR v_t IN SELECT value FROM jsonb_array_elements(COALESCE(v_g->'processingTrips', '[]'::jsonb)) AS t(value) LOOP
      CONTINUE WHEN COALESCE(btrim(COALESCE(v_t->>'id','')), '') = '';
      PERFORM public.upsert_processing_from_planner(jsonb_build_object(
        'source_kind','pig',
        'source_id', (v_g->>'id') || ':' || (v_t->>'id'),
        'program','pig',
        'pig_batch_name', COALESCE(v_g->>'batchName', v_g->>'id'),
        'processing_date', v_t->>'date',
        'source_phase', 'actual',
        'sync_run_id', v_run,
        'number_processed', v_t->>'pigCount',
        'sub_batch_attribution', COALESCE(v_t->'subAttributions', '[]'::jsonb)));
      v_pig := v_pig + 1;
    END LOOP;
  END LOOP;

  v_swept := public._processing_sweep_stale_planner_rows(v_run, NULL, NULL);

  UPDATE public.processing_asana_sync_settings
     SET last_planner_reconcile_at = now(), updated_at = now()
   WHERE id = 'singleton';

  RETURN jsonb_build_object('ok', true, 'cattle', v_cattle, 'sheep', v_sheep,
                            'broiler', v_broiler, 'pig', v_pig,
                            'retired', COALESCE((v_swept->>'archived')::int, 0),
                            'removed', COALESCE((v_swept->>'deleted')::int, 0));
END
$fn$;
REVOKE ALL ON FUNCTION public.reconcile_planner_to_processing() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reconcile_planner_to_processing() TO authenticated, service_role;

-- ── 9. Pig age inputs (port of src/lib/pig.js calcAgeRange essentials) ──────
-- Returns {min_days, max_days, estimated} for a feeder group at a reference
-- date, from actual farrowing records in the cycle window, falling back to the
-- theoretical farrowing window. NULL when the group has no usable cycle.
CREATE OR REPLACE FUNCTION public._pig_group_age_days(p_group jsonb, p_ref date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE
AS $fn$
DECLARE
  v_cycle jsonb;
  v_exposure date;
  v_fs date; v_fe date;
  v_first date; v_last date;
  v_estimated boolean := false;
BEGIN
  IF COALESCE(btrim(COALESCE(p_group->>'cycleId','')), '') = '' OR p_ref IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT c.value INTO v_cycle
    FROM jsonb_array_elements(
           COALESCE((SELECT data FROM public.app_store WHERE key = 'ppp-breeding-v1'), '[]'::jsonb)) AS c
   WHERE COALESCE(btrim(c.value->>'id'), '') = btrim(p_group->>'cycleId')
   LIMIT 1;
  IF v_cycle IS NULL THEN RETURN NULL; END IF;
  IF COALESCE(v_cycle->>'exposureStart', '') !~ '^\d{4}-\d{2}-\d{2}' THEN RETURN NULL; END IF;
  v_exposure := left(v_cycle->>'exposureStart', 10)::date;
  -- calcBreedingTimeline: GESTATION_DAYS=116, BOAR_EXPOSURE_DAYS=45; the
  -- record-match window extends farrowingEnd by 14 days (pig.js cycleRecords).
  v_fs := v_exposure + 116;
  v_fe := v_exposure + 45 - 1 + 116;

  SELECT min(left(r.value->>'farrowingDate', 10)::date),
         max(left(r.value->>'farrowingDate', 10)::date)
    INTO v_first, v_last
    FROM jsonb_array_elements(
           COALESCE((SELECT data FROM public.app_store WHERE key = 'ppp-farrowing-v1'), '[]'::jsonb)) AS r
   WHERE COALESCE(r.value->>'group', '') = COALESCE(v_cycle->>'group', '')
     AND COALESCE(r.value->>'farrowingDate', '') ~ '^\d{4}-\d{2}-\d{2}'
     AND left(r.value->>'farrowingDate', 10)::date BETWEEN v_fs AND (v_fe + 14);

  IF v_first IS NULL THEN
    v_first := v_fs;
    v_last := v_fe;
    v_estimated := true;
  END IF;
  RETURN jsonb_build_object(
    'min_days', GREATEST(p_ref - v_last, 0),
    'max_days', GREATEST(p_ref - v_first, 0),
    'estimated', v_estimated);
END
$fn$;
REVOKE ALL ON FUNCTION public._pig_group_age_days(jsonb, date) FROM PUBLIC, anon, authenticated;

-- ── 10. Live source projection for one record ───────────────────────────────
-- The normalized `source` object the UI renders instead of stale snapshots.
CREATE OR REPLACE FUNCTION public._processing_source_projection(p_rec public.processing_records)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE
AS $fn$
DECLARE
  v_out jsonb;
  v_b jsonb; v_g jsonb; v_t jsonb;
  v_row RECORD;
  v_tags text;
  v_locked boolean;
  v_age jsonb;
  v_phase text;
BEGIN
  IF p_rec.source_kind IS NULL OR p_rec.source_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_rec.source_kind = 'broiler' THEN
    SELECT b.value INTO v_b
      FROM jsonb_array_elements(
             COALESCE((SELECT data FROM public.app_store WHERE key = 'ppp-v4'), '[]'::jsonb)) AS b
     WHERE COALESCE(btrim(b.value->>'id'), '') = p_rec.source_id
     LIMIT 1;
    IF v_b IS NULL THEN RETURN jsonb_build_object('matched', false); END IF;
    RETURN jsonb_build_object(
      'matched', true,
      'batch_name', v_b->>'name',
      'hatch_date', CASE WHEN COALESCE(v_b->>'hatchDate', v_b->>'hatch_date') ~ '^\d{4}-\d{2}-\d{2}'
                         THEN left(COALESCE(v_b->>'hatchDate', v_b->>'hatch_date'), 10) END,
      'processing_date', CASE WHEN COALESCE(v_b->>'processingDate', v_b->>'processing_date') ~ '^\d{4}-\d{2}-\d{2}'
                              THEN left(COALESCE(v_b->>'processingDate', v_b->>'processing_date'), 10) END,
      'count', NULLIF(btrim(COALESCE(v_b->>'totalToProcessor', v_b->>'total_to_processor', '')), '')::int,
      'age_days', CASE WHEN COALESCE(v_b->>'processingDate', v_b->>'processing_date') ~ '^\d{4}-\d{2}-\d{2}'
                        AND COALESCE(v_b->>'hatchDate', v_b->>'hatch_date') ~ '^\d{4}-\d{2}-\d{2}'
                       THEN left(COALESCE(v_b->>'processingDate', v_b->>'processing_date'), 10)::date
                            - left(COALESCE(v_b->>'hatchDate', v_b->>'hatch_date'), 10)::date END);
  END IF;

  IF p_rec.source_kind IN ('cattle', 'sheep') THEN
    IF p_rec.source_kind = 'cattle' THEN
      SELECT id, name,
             COALESCE(actual_process_date, planned_process_date) AS pdate,
             actual_process_date, cows_detail AS detail
        INTO v_row
        FROM public.cattle_processing_batches WHERE id = p_rec.source_id;
    ELSE
      SELECT id, name,
             COALESCE(actual_process_date, planned_process_date) AS pdate,
             actual_process_date, sheep_detail AS detail
        INTO v_row
        FROM public.sheep_processing_batches WHERE id = p_rec.source_id;
    END IF;
    IF v_row.id IS NULL THEN RETURN jsonb_build_object('matched', false); END IF;
    SELECT string_agg(DISTINCT NULLIF(btrim(d.value->>'tag'), ''), ' ') INTO v_tags
      FROM jsonb_array_elements(COALESCE(v_row.detail, '[]'::jsonb)) AS d;
    -- Live animal age range at the processing date, from current birth_date.
    IF p_rec.source_kind = 'cattle' THEN
      SELECT jsonb_build_object(
               'min_days', min(v_row.pdate - c.birth_date),
               'max_days', max(v_row.pdate - c.birth_date))
        INTO v_age
        FROM jsonb_array_elements(COALESCE(v_row.detail, '[]'::jsonb)) AS d
        JOIN public.cattle c ON c.id = d.value->>'cattle_id'
       WHERE c.birth_date IS NOT NULL AND v_row.pdate IS NOT NULL;
    ELSE
      SELECT jsonb_build_object(
               'min_days', min(v_row.pdate - s.birth_date),
               'max_days', max(v_row.pdate - s.birth_date))
        INTO v_age
        FROM jsonb_array_elements(COALESCE(v_row.detail, '[]'::jsonb)) AS d
        JOIN public.sheep s ON s.id = d.value->>'sheep_id'
       WHERE s.birth_date IS NOT NULL AND v_row.pdate IS NOT NULL;
    END IF;
    RETURN jsonb_build_object(
      'matched', true,
      'batch_name', v_row.name,
      'processing_date', v_row.pdate,
      'is_actual_date', v_row.actual_process_date IS NOT NULL,
      'count', jsonb_array_length(COALESCE(v_row.detail, '[]'::jsonb)),
      'animal_tags', COALESCE(v_tags, ''),
      'age', v_age);
  END IF;

  IF p_rec.source_kind = 'pig' THEN
    SELECT g.value INTO v_g
      FROM jsonb_array_elements(
             COALESCE((SELECT data FROM public.app_store WHERE key = 'ppp-feeders-v1'), '[]'::jsonb)) AS g
     WHERE COALESCE(btrim(g.value->>'id'), '') = split_part(p_rec.source_id, ':', 1)
     LIMIT 1;
    IF v_g IS NULL THEN RETURN jsonb_build_object('matched', false); END IF;
    v_phase := 'actual';
    SELECT t.value INTO v_t
      FROM jsonb_array_elements(COALESCE(v_g->'processingTrips', '[]'::jsonb)) AS t
     WHERE COALESCE(btrim(t.value->>'id'), '') = split_part(p_rec.source_id, ':', 2)
     LIMIT 1;
    IF v_t IS NULL THEN
      v_phase := 'planned';
      SELECT t.value INTO v_t
        FROM jsonb_array_elements(COALESCE(v_g->'plannedProcessingTrips', '[]'::jsonb)) AS t
       WHERE COALESCE(btrim(t.value->>'id'), '') = split_part(p_rec.source_id, ':', 2)
       LIMIT 1;
    END IF;
    IF v_t IS NULL THEN RETURN jsonb_build_object('matched', false); END IF;
    SELECT COALESCE((data -> split_part(p_rec.source_id, ':', 2) ->> 'locked')::boolean, false)
      INTO v_locked
      FROM public.app_store WHERE key = 'ppp-pig-planned-trip-locks-v1';
    v_age := public._pig_group_age_days(
      v_g,
      CASE WHEN COALESCE(v_t->>'date','') ~ '^\d{4}-\d{2}-\d{2}' THEN left(v_t->>'date',10)::date
           ELSE p_rec.processing_date END);
    RETURN jsonb_build_object(
      'matched', true,
      'batch_name', COALESCE(v_g->>'batchName', v_g->>'id'),
      'group_id', v_g->>'id',
      'trip_id', split_part(p_rec.source_id, ':', 2),
      'trip_ordinal', p_rec.trip_ordinal,
      'trip_label', 'Trip ' || COALESCE(p_rec.trip_ordinal, 0),
      'phase', v_phase,
      'scheduled_with_processor', COALESCE(v_locked, false),
      'processing_date', CASE WHEN COALESCE(v_t->>'date','') ~ '^\d{4}-\d{2}-\d{2}' THEN left(v_t->>'date',10) END,
      'count', CASE WHEN v_phase = 'actual'
                    THEN NULLIF(btrim(COALESCE(v_t->>'pigCount','')), '')::int
                    ELSE NULLIF(btrim(COALESCE(v_t->>'plannedCount','')), '')::int END,
      'age', v_age);
  END IF;

  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public._processing_source_projection(public.processing_records) FROM PUBLIC, anon, authenticated;

-- ── 11. Read RPC reissues: normalized projection + effective status ─────────
CREATE OR REPLACE FUNCTION public.list_processing_records(
  p_year             int  DEFAULT NULL,
  p_program          text DEFAULT NULL,
  p_include_archived boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE
AS $fn$
DECLARE v_out jsonb;
BEGIN
  PERFORM public._processing_require_operational();
  SELECT COALESCE(jsonb_agg(row ORDER BY row->>'program', (row->>'processing_date')), '[]'::jsonb)
    INTO v_out
  FROM (
    SELECT jsonb_build_object(
      'id', r.id, 'record_type', r.record_type, 'program', r.program, 'title', r.title,
      'processing_date', r.processing_date, 'status', r.status,
      'effective_status', public._processing_effective_status(r),
      'completed_at', r.completed_at,
      'processor', r.processor, 'number_processed', r.number_processed, 'customer', r.customer,
      'source_kind', r.source_kind, 'source_id', r.source_id, 'source_phase', r.source_phase,
      'trip_ordinal', r.trip_ordinal, 'archived', r.archived,
      'source_removed_at', r.source_removed_at,
      'fields', r.fields, 'historical_snapshot', r.historical_snapshot,
      'template_version', r.template_version,
      'subtask_total', COALESCE(st.total, 0), 'subtask_done', COALESCE(st.done, 0),
      'source', src.projection,
      'live_count', public._processing_live_source_count(r),
      -- Backward-compatible broiler read (retired from the UI, kept as data).
      'time_on_farm_days', CASE WHEN r.source_kind = 'broiler'
                                THEN (src.projection->>'age_days')::int END,
      'search_text', lower(concat_ws(' ',
        r.title, r.processor,
        (SELECT string_agg(c.value #>> '{}', ' ') FROM jsonb_array_elements(COALESCE(r.customer, '[]'::jsonb)) AS c),
        src.projection->>'batch_name',
        CASE WHEN r.source_kind = 'pig' THEN 'trip ' || COALESCE(r.trip_ordinal, 0) END,
        src.projection->>'animal_tags'))
    ) AS row
    FROM public.processing_records r
    LEFT JOIN LATERAL (
      SELECT count(*) AS total, count(*) FILTER (WHERE s.done) AS done
      FROM public.processing_subtasks s WHERE s.record_id = r.id
    ) st ON true
    LEFT JOIN LATERAL (
      SELECT public._processing_source_projection(r) AS projection
    ) src ON true
    WHERE (p_include_archived OR r.archived = false)
      AND r.record_type <> 'import_exception'
      AND (p_program IS NULL OR r.program = p_program)
      AND (p_year IS NULL OR date_part('year', r.processing_date) = p_year)
  ) q;
  RETURN v_out;
END
$fn$;
REVOKE ALL ON FUNCTION public.list_processing_records(int, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_processing_records(int, text, boolean) TO authenticated;

-- Per-animal detail for cattle/sheep: live tag + DOB from the animal row, age
-- at the batch processing date, hanging weight from the batch detail JSON, and
-- the latest live weight resolved retag-aware (current tag + old_tags entries
-- whose source <> 'import'), species-scoped through weigh_in_sessions.
CREATE OR REPLACE FUNCTION public._processing_animal_detail(p_rec public.processing_records)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE
AS $fn$
DECLARE
  v_detail jsonb;
  v_pdate  date;
  v_out    jsonb;
  v_g      jsonb;
  v_t      jsonb;
BEGIN
  IF p_rec.source_kind = 'cattle' THEN
    SELECT cows_detail, COALESCE(actual_process_date, planned_process_date)
      INTO v_detail, v_pdate
      FROM public.cattle_processing_batches WHERE id = p_rec.source_id;
    IF v_detail IS NULL THEN RETURN NULL; END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'animal_id', c.id,
             'tag', c.tag,
             'birth_date', c.birth_date,
             'age_days', CASE WHEN c.birth_date IS NOT NULL AND v_pdate IS NOT NULL
                              THEN v_pdate - c.birth_date END,
             'hanging_weight', NULLIF(btrim(COALESCE(d.value->>'hanging_weight','')), '')::numeric,
             'live_weight', lw.weight
           ) ORDER BY ord), '[]'::jsonb)
      INTO v_out
      FROM jsonb_array_elements(COALESCE(v_detail, '[]'::jsonb)) WITH ORDINALITY AS d(value, ord)
      JOIN public.cattle c ON c.id = d.value->>'cattle_id'
      LEFT JOIN LATERAL (
        SELECT w.weight
          FROM public.weigh_ins w
          JOIN public.weigh_in_sessions ws ON ws.id = w.session_id AND ws.species = 'cattle'
         WHERE w.weight IS NOT NULL AND w.weight > 0
           AND (w.tag = c.tag OR w.tag IN (
                 SELECT ot.value->>'tag'
                   FROM jsonb_array_elements(COALESCE(c.old_tags, '[]'::jsonb)) AS ot
                  WHERE COALESCE(ot.value->>'source', '') <> 'import'))
         ORDER BY w.entered_at DESC
         LIMIT 1
      ) lw ON true;
    RETURN COALESCE(v_out, '[]'::jsonb);
  END IF;

  IF p_rec.source_kind = 'sheep' THEN
    SELECT sheep_detail, COALESCE(actual_process_date, planned_process_date)
      INTO v_detail, v_pdate
      FROM public.sheep_processing_batches WHERE id = p_rec.source_id;
    IF v_detail IS NULL THEN RETURN NULL; END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'animal_id', s.id,
             'tag', s.tag,
             'birth_date', s.birth_date,
             'age_days', CASE WHEN s.birth_date IS NOT NULL AND v_pdate IS NOT NULL
                              THEN v_pdate - s.birth_date END,
             'hanging_weight', NULLIF(btrim(COALESCE(d.value->>'hanging_weight','')), '')::numeric,
             'live_weight', lw.weight
           ) ORDER BY ord), '[]'::jsonb)
      INTO v_out
      FROM jsonb_array_elements(COALESCE(v_detail, '[]'::jsonb)) WITH ORDINALITY AS d(value, ord)
      JOIN public.sheep s ON s.id = d.value->>'sheep_id'
      LEFT JOIN LATERAL (
        SELECT w.weight
          FROM public.weigh_ins w
          JOIN public.weigh_in_sessions ws ON ws.id = w.session_id AND ws.species = 'sheep'
         WHERE w.weight IS NOT NULL AND w.weight > 0
           AND (w.tag = s.tag OR w.tag IN (
                 SELECT ot.value->>'tag'
                   FROM jsonb_array_elements(COALESCE(s.old_tags, '[]'::jsonb)) AS ot
                  WHERE COALESCE(ot.value->>'source', '') <> 'import'))
         ORDER BY w.entered_at DESC
         LIMIT 1
      ) lw ON true;
    RETURN COALESCE(v_out, '[]'::jsonb);
  END IF;

  IF p_rec.source_kind = 'pig' AND p_rec.source_phase = 'actual' THEN
    -- Tagless: linked weigh-ins in deterministic (entered_at, id) order; the
    -- client labels them Pig 1..N. Falls back to the trip's stored legacy
    -- liveWeights string when no linked weigh-ins exist.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'weigh_in_id', w.id,
             'live_weight', w.weight
           ) ORDER BY w.entered_at ASC, w.id ASC), '[]'::jsonb)
      INTO v_out
      FROM public.weigh_ins w
     WHERE w.sent_to_trip_id = split_part(p_rec.source_id, ':', 2)
       AND w.sent_to_group_id = split_part(p_rec.source_id, ':', 1);
    IF jsonb_array_length(v_out) > 0 THEN RETURN v_out; END IF;
    SELECT g.value INTO v_g
      FROM jsonb_array_elements(
             COALESCE((SELECT data FROM public.app_store WHERE key = 'ppp-feeders-v1'), '[]'::jsonb)) AS g
     WHERE COALESCE(btrim(g.value->>'id'), '') = split_part(p_rec.source_id, ':', 1)
     LIMIT 1;
    SELECT t.value INTO v_t
      FROM jsonb_array_elements(COALESCE(v_g->'processingTrips', '[]'::jsonb)) AS t
     WHERE COALESCE(btrim(t.value->>'id'), '') = split_part(p_rec.source_id, ':', 2)
     LIMIT 1;
    IF v_t IS NULL THEN RETURN '[]'::jsonb; END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'weigh_in_id', NULL,
             'live_weight', NULLIF(btrim(wt), '')::numeric
           ) ORDER BY ord), '[]'::jsonb)
      INTO v_out
      FROM unnest(string_to_array(COALESCE(v_t->>'liveWeights', ''), ' ')) WITH ORDINALITY AS x(wt, ord)
     WHERE NULLIF(btrim(wt), '') IS NOT NULL;
    RETURN v_out;
  END IF;

  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public._processing_animal_detail(public.processing_records) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_processing_record(p_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE
AS $fn$
DECLARE
  v_row  public.processing_records;
  v_rec  jsonb;
  v_subs jsonb;
  v_atts jsonb;
  v_blockers text[];
BEGIN
  PERFORM public._processing_require_operational();
  SELECT * INTO v_row FROM public.processing_records WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  v_rec := to_jsonb(v_row) || jsonb_build_object(
    'effective_status', public._processing_effective_status(v_row),
    'source', public._processing_source_projection(v_row),
    'live_count', public._processing_live_source_count(v_row),
    'animals', public._processing_animal_detail(v_row));

  SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.sort_order, s.created_at), '[]'::jsonb)
    INTO v_subs FROM public.processing_subtasks s WHERE s.record_id = p_id;
  SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.created_at DESC), '[]'::jsonb)
    INTO v_atts FROM public.processing_attachments a WHERE a.record_id = p_id;
  v_blockers := public._processing_completion_blockers(p_id);
  RETURN jsonb_build_object('record', v_rec, 'subtasks', v_subs, 'attachments', v_atts,
                            'completion_blockers', to_jsonb(v_blockers));
END
$fn$;
REVOKE ALL ON FUNCTION public.get_processing_record(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_processing_record(text) TO authenticated;

-- ── 12. Transactional Pig planner mutations ──────────────────────────────────
-- Shared internals. All Pig mutation RPCs are management/admin gated (matching
-- the existing client gate on planned-trip/send flows), lock the feeders
-- app_store row FOR UPDATE, perform targeted JSON surgery that preserves every
-- unrelated field, then re-sync that group's Processing records in the SAME
-- transaction. fcrCached remains a client-maintained planner display cache.

CREATE OR REPLACE FUNCTION public._pig_require_manager()
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_role text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'pig planner: authenticated caller required';
  END IF;
  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('management', 'admin') THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: caller role % cannot manage pig processing trips', COALESCE(v_role, 'null');
  END IF;
  RETURN v_role;
END
$fn$;
REVOKE ALL ON FUNCTION public._pig_require_manager() FROM PUBLIC, anon, authenticated;

-- Locks + returns the feeders array. Raises when the store row is missing.
CREATE OR REPLACE FUNCTION public._pig_feeders_lock()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_data jsonb;
BEGIN
  SELECT data INTO v_data FROM public.app_store WHERE key = 'ppp-feeders-v1' FOR UPDATE;
  IF NOT FOUND OR v_data IS NULL OR jsonb_typeof(v_data) <> 'array' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: pig feeder store not available';
  END IF;
  RETURN v_data;
END
$fn$;
REVOKE ALL ON FUNCTION public._pig_feeders_lock() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._pig_feeders_save(p_data jsonb)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $fn$
  UPDATE public.app_store SET data = p_data, updated_at = now() WHERE key = 'ppp-feeders-v1';
$fn$;
REVOKE ALL ON FUNCTION public._pig_feeders_save(jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._pig_trip_locked(p_trip_id text)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE
AS $fn$
  SELECT COALESCE((SELECT (data -> p_trip_id ->> 'locked')::boolean
                     FROM public.app_store WHERE key = 'ppp-pig-planned-trip-locks-v1'), false);
$fn$;
REVOKE ALL ON FUNCTION public._pig_trip_locked(text) FROM PUBLIC, anon, authenticated;

-- Re-sync ONE group's Processing records (planned + actual) and sweep that
-- group's stale rows with the empty-remove/worked-archive rule.
CREATE OR REPLACE FUNCTION public._pig_sync_group_records(p_group jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_run text := 'pig-sync-' || gen_random_uuid()::text;
  v_t jsonb;
  v_sub_name text;
  v_gid text := COALESCE(btrim(p_group->>'id'), '');
BEGIN
  IF v_gid = '' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: pig group id required for record sync';
  END IF;
  FOR v_t IN SELECT value FROM jsonb_array_elements(COALESCE(p_group->'plannedProcessingTrips', '[]'::jsonb)) AS t(value) LOOP
    CONTINUE WHEN COALESCE(btrim(COALESCE(v_t->>'id','')), '') = '';
    SELECT sb.value->>'name' INTO v_sub_name
      FROM jsonb_array_elements(COALESCE(p_group->'subBatches', '[]'::jsonb)) AS sb
     WHERE COALESCE(btrim(sb.value->>'id'), '') = COALESCE(btrim(v_t->>'subBatchId'), '')
     LIMIT 1;
    PERFORM public.upsert_processing_from_planner(jsonb_build_object(
      'source_kind','pig', 'source_id', v_gid || ':' || (v_t->>'id'), 'program','pig',
      'pig_batch_name', COALESCE(p_group->>'batchName', v_gid),
      'processing_date', v_t->>'date', 'source_phase', 'planned', 'sync_run_id', v_run,
      'number_processed', v_t->>'plannedCount',
      'sub_batch_attribution', jsonb_build_array(jsonb_build_object(
        'subId', v_t->>'subBatchId',
        'subBatchName', COALESCE(v_sub_name, v_t->>'subBatchId'),
        'sex', CASE WHEN v_t->>'sex' = 'boar' THEN 'Boars' ELSE 'Gilts' END,
        'count', COALESCE(NULLIF(btrim(COALESCE(v_t->>'plannedCount','')), '')::int, 0)))));
  END LOOP;
  FOR v_t IN SELECT value FROM jsonb_array_elements(COALESCE(p_group->'processingTrips', '[]'::jsonb)) AS t(value) LOOP
    CONTINUE WHEN COALESCE(btrim(COALESCE(v_t->>'id','')), '') = '';
    PERFORM public.upsert_processing_from_planner(jsonb_build_object(
      'source_kind','pig', 'source_id', v_gid || ':' || (v_t->>'id'), 'program','pig',
      'pig_batch_name', COALESCE(p_group->>'batchName', v_gid),
      'processing_date', v_t->>'date', 'source_phase', 'actual', 'sync_run_id', v_run,
      'number_processed', v_t->>'pigCount',
      'sub_batch_attribution', COALESCE(v_t->'subAttributions', '[]'::jsonb)));
  END LOOP;
  RETURN public._processing_sweep_stale_planner_rows(v_run, 'pig', v_gid || ':');
END
$fn$;
REVOKE ALL ON FUNCTION public._pig_sync_group_records(jsonb) FROM PUBLIC, anon, authenticated;

-- Appends a lineage entry (and best-effort activity) to the record for one
-- pig source id, when that record exists.
CREATE OR REPLACE FUNCTION public._pig_record_lineage(p_group_id text, p_trip_id text, p_entry jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_id text;
BEGIN
  SELECT id INTO v_id FROM public.processing_records
   WHERE source_kind = 'pig' AND source_id = p_group_id || ':' || p_trip_id;
  IF v_id IS NULL THEN RETURN; END IF;
  UPDATE public.processing_records
     SET lineage = lineage || jsonb_build_array(p_entry || jsonb_build_object('at', now())),
         updated_at = now()
   WHERE id = v_id;
  PERFORM public._processing_emit_activity(
    v_id, 'field.updated', COALESCE(p_entry->>'event', 'lineage'), p_entry);
END
$fn$;
REVOKE ALL ON FUNCTION public._pig_record_lineage(text, text, jsonb) FROM PUBLIC, anon, authenticated;

-- Add a planned trip (port of src/lib/pigForecast.js addPlannedTrip). The
-- 6-key persisted row shape {id,date,sex,subBatchId,plannedCount,order} is
-- preserved byte-for-byte; a positive-count add draws from a single existing
-- chain trip (prev preferred, else next) to preserve the chain total.
CREATE OR REPLACE FUNCTION public.pig_add_planned_trip(
  p_group_id text, p_sub_batch_id text, p_sex text, p_date text, p_count int
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_data jsonb; v_gidx int := -1; v_group jsonb;
  v_chain jsonb; v_elem jsonb;
  v_max_order int := -1;
  v_prev jsonb; v_next jsonb; v_source jsonb;
  v_new jsonb; v_new_id text := 'pt-' || gen_random_uuid()::text;
  v_trips jsonb; i int;
BEGIN
  PERFORM public._pig_require_manager();
  IF p_sex NOT IN ('gilt', 'boar') THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: sex must be gilt or boar';
  END IF;
  IF COALESCE(p_date, '') !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: date must be YYYY-MM-DD';
  END IF;
  IF p_count IS NULL OR p_count < 0 THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: plannedCount must be a non-negative integer';
  END IF;

  v_data := public._pig_feeders_lock();
  FOR i IN 0 .. jsonb_array_length(v_data) - 1 LOOP
    IF COALESCE(btrim(v_data->i->>'id'), '') = p_group_id THEN v_gidx := i; EXIT; END IF;
  END LOOP;
  IF v_gidx < 0 THEN RAISE EXCEPTION 'PROCESSING_VALIDATION: pig group % not found', p_group_id; END IF;
  v_group := v_data->v_gidx;
  v_trips := COALESCE(v_group->'plannedProcessingTrips', '[]'::jsonb);

  -- Chain = same (subBatchId, sex), sorted (date, order). A locked trip in the
  -- chain blocks adds (client isChainLocked rule).
  SELECT COALESCE(jsonb_agg(t.value ORDER BY t.value->>'date', (t.value->>'order')::numeric NULLS LAST), '[]'::jsonb)
    INTO v_chain
    FROM jsonb_array_elements(v_trips) AS t
   WHERE t.value->>'subBatchId' = p_sub_batch_id AND t.value->>'sex' = p_sex;
  FOR i IN 0 .. jsonb_array_length(v_chain) - 1 LOOP
    IF public._pig_trip_locked(v_chain->i->>'id') THEN
      RAISE EXCEPTION 'PROCESSING_VALIDATION: chain has a locked (processor-scheduled) trip — unlock before adding';
    END IF;
    IF COALESCE((v_chain->i->>'order')::numeric, -1) > v_max_order THEN
      v_max_order := (v_chain->i->>'order')::numeric;
    END IF;
  END LOOP;

  v_new := jsonb_build_object('id', v_new_id, 'date', p_date, 'sex', p_sex,
                              'subBatchId', p_sub_batch_id, 'plannedCount', p_count,
                              'order', v_max_order + 1);

  IF p_count > 0 AND jsonb_array_length(v_chain) > 0 THEN
    FOR i IN 0 .. jsonb_array_length(v_chain) - 1 LOOP
      v_elem := v_chain->i;
      IF v_elem->>'date' <= p_date THEN v_prev := v_elem;
      ELSIF v_next IS NULL THEN v_next := v_elem; END IF;
    END LOOP;
    IF v_prev IS NOT NULL AND COALESCE((v_prev->>'plannedCount')::int, 0) >= p_count THEN
      v_source := v_prev;
    ELSIF v_next IS NOT NULL AND COALESCE((v_next->>'plannedCount')::int, 0) >= p_count THEN
      v_source := v_next;
    ELSE
      RAISE EXCEPTION 'PROCESSING_VALIDATION: cannot draw the requested count from the existing chain';
    END IF;
    SELECT COALESCE(jsonb_agg(
             CASE WHEN t.value->>'id' = v_source->>'id'
                  THEN t.value || jsonb_build_object('plannedCount', COALESCE((t.value->>'plannedCount')::int, 0) - p_count)
                  ELSE t.value END ORDER BY ord), '[]'::jsonb)
      INTO v_trips
      FROM jsonb_array_elements(v_trips) WITH ORDINALITY AS t(value, ord);
  END IF;

  v_trips := v_trips || jsonb_build_array(v_new);
  v_group := v_group || jsonb_build_object('plannedProcessingTrips', v_trips);
  v_data := jsonb_set(v_data, ARRAY[v_gidx::text], v_group);
  PERFORM public._pig_feeders_save(v_data);
  PERFORM public._pig_sync_group_records(v_group);
  RETURN jsonb_build_object('ok', true, 'trip', v_new);
END
$fn$;
REVOKE ALL ON FUNCTION public.pig_add_planned_trip(text, text, text, text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pig_add_planned_trip(text, text, text, text, int) TO authenticated;

-- Set a planned trip's date (locked trips refuse).
CREATE OR REPLACE FUNCTION public.pig_set_planned_trip_date(p_group_id text, p_trip_id text, p_date text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_data jsonb; v_gidx int := -1; v_group jsonb; v_trips jsonb; i int;
  v_found boolean := false;
BEGIN
  PERFORM public._pig_require_manager();
  IF COALESCE(p_date, '') !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: date must be YYYY-MM-DD';
  END IF;
  IF public._pig_trip_locked(p_trip_id) THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: trip is locked (processor scheduled) — unlock before editing';
  END IF;
  v_data := public._pig_feeders_lock();
  FOR i IN 0 .. jsonb_array_length(v_data) - 1 LOOP
    IF COALESCE(btrim(v_data->i->>'id'), '') = p_group_id THEN v_gidx := i; EXIT; END IF;
  END LOOP;
  IF v_gidx < 0 THEN RAISE EXCEPTION 'PROCESSING_VALIDATION: pig group % not found', p_group_id; END IF;
  v_group := v_data->v_gidx;
  SELECT COALESCE(jsonb_agg(
           CASE WHEN t.value->>'id' = p_trip_id
                THEN t.value || jsonb_build_object('date', p_date)
                ELSE t.value END ORDER BY ord), '[]'::jsonb),
         bool_or(t.value->>'id' = p_trip_id)
    INTO v_trips, v_found
    FROM jsonb_array_elements(COALESCE(v_group->'plannedProcessingTrips', '[]'::jsonb))
           WITH ORDINALITY AS t(value, ord);
  IF NOT COALESCE(v_found, false) THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: planned trip % not found', p_trip_id;
  END IF;
  v_group := v_group || jsonb_build_object('plannedProcessingTrips', v_trips);
  v_data := jsonb_set(v_data, ARRAY[v_gidx::text], v_group);
  PERFORM public._pig_feeders_save(v_data);
  PERFORM public._pig_sync_group_records(v_group);
  RETURN jsonb_build_object('ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.pig_set_planned_trip_date(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pig_set_planned_trip_date(text, text, text) TO authenticated;

-- Count-only move between two chain trips (port of movePigsBetweenTrips).
CREATE OR REPLACE FUNCTION public.pig_move_planned_pigs(p_group_id text, p_from_trip_id text, p_to_trip_id text, p_count int)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_data jsonb; v_gidx int := -1; v_group jsonb; v_trips jsonb;
  v_from jsonb; v_to jsonb; i int;
BEGIN
  PERFORM public._pig_require_manager();
  IF p_count IS NULL OR p_count <= 0 THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: count must be a positive integer';
  END IF;
  IF p_from_trip_id = p_to_trip_id THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: from and to trips must differ';
  END IF;
  IF public._pig_trip_locked(p_from_trip_id) OR public._pig_trip_locked(p_to_trip_id) THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: a locked (processor-scheduled) trip cannot move pigs';
  END IF;
  v_data := public._pig_feeders_lock();
  FOR i IN 0 .. jsonb_array_length(v_data) - 1 LOOP
    IF COALESCE(btrim(v_data->i->>'id'), '') = p_group_id THEN v_gidx := i; EXIT; END IF;
  END LOOP;
  IF v_gidx < 0 THEN RAISE EXCEPTION 'PROCESSING_VALIDATION: pig group % not found', p_group_id; END IF;
  v_group := v_data->v_gidx;
  v_trips := COALESCE(v_group->'plannedProcessingTrips', '[]'::jsonb);
  SELECT t.value INTO v_from FROM jsonb_array_elements(v_trips) AS t WHERE t.value->>'id' = p_from_trip_id;
  SELECT t.value INTO v_to   FROM jsonb_array_elements(v_trips) AS t WHERE t.value->>'id' = p_to_trip_id;
  IF v_from IS NULL THEN RAISE EXCEPTION 'PROCESSING_VALIDATION: from trip % not found', p_from_trip_id; END IF;
  IF v_to   IS NULL THEN RAISE EXCEPTION 'PROCESSING_VALIDATION: to trip % not found', p_to_trip_id; END IF;
  IF v_from->>'sex' IS DISTINCT FROM v_to->>'sex'
     OR v_from->>'subBatchId' IS DISTINCT FROM v_to->>'subBatchId' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: planned trips must share sex and subBatchId';
  END IF;
  IF p_count > COALESCE((v_from->>'plannedCount')::int, 0) THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: count exceeds the source trip plannedCount';
  END IF;
  SELECT COALESCE(jsonb_agg(
           CASE WHEN t.value->>'id' = p_from_trip_id
                THEN t.value || jsonb_build_object('plannedCount', COALESCE((t.value->>'plannedCount')::int, 0) - p_count)
                WHEN t.value->>'id' = p_to_trip_id
                THEN t.value || jsonb_build_object('plannedCount', COALESCE((t.value->>'plannedCount')::int, 0) + p_count)
                ELSE t.value END ORDER BY ord), '[]'::jsonb)
    INTO v_trips
    FROM jsonb_array_elements(v_trips) WITH ORDINALITY AS t(value, ord);
  v_group := v_group || jsonb_build_object('plannedProcessingTrips', v_trips);
  v_data := jsonb_set(v_data, ARRAY[v_gidx::text], v_group);
  PERFORM public._pig_feeders_save(v_data);
  PERFORM public._pig_sync_group_records(v_group);
  RETURN jsonb_build_object('ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.pig_move_planned_pigs(text, text, text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pig_move_planned_pigs(text, text, text, int) TO authenticated;

-- Delete a planned trip, folding its count onto the next (else previous)
-- chain trip (port of deletePlannedTripWithReconciliation).
CREATE OR REPLACE FUNCTION public.pig_delete_planned_trip(p_group_id text, p_trip_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_data jsonb; v_gidx int := -1; v_group jsonb; v_trips jsonb;
  v_target jsonb; v_chain jsonb; v_recipient jsonb;
  v_idx int := -1; i int; v_moved int;
BEGIN
  PERFORM public._pig_require_manager();
  IF public._pig_trip_locked(p_trip_id) THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: trip is locked (processor scheduled) — unlock before deleting';
  END IF;
  v_data := public._pig_feeders_lock();
  FOR i IN 0 .. jsonb_array_length(v_data) - 1 LOOP
    IF COALESCE(btrim(v_data->i->>'id'), '') = p_group_id THEN v_gidx := i; EXIT; END IF;
  END LOOP;
  IF v_gidx < 0 THEN RAISE EXCEPTION 'PROCESSING_VALIDATION: pig group % not found', p_group_id; END IF;
  v_group := v_data->v_gidx;
  v_trips := COALESCE(v_group->'plannedProcessingTrips', '[]'::jsonb);
  SELECT t.value INTO v_target FROM jsonb_array_elements(v_trips) AS t WHERE t.value->>'id' = p_trip_id;
  IF v_target IS NULL THEN RAISE EXCEPTION 'PROCESSING_VALIDATION: planned trip % not found', p_trip_id; END IF;

  SELECT COALESCE(jsonb_agg(t.value ORDER BY t.value->>'date', (t.value->>'order')::numeric NULLS LAST), '[]'::jsonb)
    INTO v_chain
    FROM jsonb_array_elements(v_trips) AS t
   WHERE t.value->>'subBatchId' = v_target->>'subBatchId' AND t.value->>'sex' = v_target->>'sex';
  IF jsonb_array_length(v_chain) <= 1 THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: cannot delete the only planned trip in this chain';
  END IF;
  FOR i IN 0 .. jsonb_array_length(v_chain) - 1 LOOP
    IF v_chain->i->>'id' = p_trip_id THEN v_idx := i; EXIT; END IF;
  END LOOP;
  IF v_idx + 1 < jsonb_array_length(v_chain) THEN v_recipient := v_chain->(v_idx + 1);
  ELSIF v_idx > 0 THEN v_recipient := v_chain->(v_idx - 1);
  ELSE RAISE EXCEPTION 'PROCESSING_VALIDATION: no recipient trip available for reconciliation'; END IF;
  IF public._pig_trip_locked(v_recipient->>'id') THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: reconciliation recipient trip is locked (processor scheduled)';
  END IF;

  v_moved := COALESCE((v_target->>'plannedCount')::int, 0);
  SELECT COALESCE(jsonb_agg(
           CASE WHEN t.value->>'id' = v_recipient->>'id'
                THEN t.value || jsonb_build_object('plannedCount', COALESCE((t.value->>'plannedCount')::int, 0) + v_moved)
                ELSE t.value END ORDER BY ord), '[]'::jsonb)
    INTO v_trips
    FROM jsonb_array_elements(v_trips) WITH ORDINALITY AS t(value, ord)
   WHERE t.value->>'id' <> p_trip_id;

  v_group := v_group || jsonb_build_object('plannedProcessingTrips', v_trips);
  v_data := jsonb_set(v_data, ARRAY[v_gidx::text], v_group);
  PERFORM public._pig_feeders_save(v_data);
  PERFORM public._pig_record_lineage(p_group_id, v_recipient->>'id',
    jsonb_build_object('event', 'plan_folded', 'from_trip', p_trip_id, 'count', v_moved));
  PERFORM public._pig_sync_group_records(v_group);
  RETURN jsonb_build_object('ok', true, 'recipient_trip_id', v_recipient->>'id', 'moved_count', v_moved);
END
$fn$;
REVOKE ALL ON FUNCTION public.pig_delete_planned_trip(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pig_delete_planned_trip(text, text) TO authenticated;

-- Send weigh-in entries to the processor: transactional port of the client
-- send flow + reconcilePlannedTripsForSend, with one locked-spec change: the
-- target planned trip's ID IS the actual trip id (promotion — the Processing
-- record survives), so an under-send remainder always moves forward (next
-- planned trip, else a NEW planned trip id at the target's date).
CREATE OR REPLACE FUNCTION public.pig_send_to_trip(
  p_group_id text, p_sub_batch_id text, p_sex text, p_weigh_in_ids text[]
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_data jsonb; v_gidx int := -1; v_group jsonb; v_trips jsonb;
  v_chain jsonb; v_target jsonb; v_target_idx int := -1;
  v_send int; v_available int := 0; v_needed int;
  v_removed text[] := ARRAY[]::text[];
  v_adjusted jsonb := '{}'::jsonb;
  v_remainder int := 0;
  v_new_plan jsonb := NULL;
  v_sub_name text;
  v_w RECORD; v_weights text := ''; v_today date := public._processing_today_chicago();
  v_actual jsonb; v_actuals jsonb; v_max_order numeric := -1;
  i int; v_elem jsonb;
BEGIN
  PERFORM public._pig_require_manager();
  IF p_sex NOT IN ('gilt', 'boar') THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: sex must be gilt or boar';
  END IF;
  v_send := COALESCE(array_length(p_weigh_in_ids, 1), 0);
  IF v_send <= 0 THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: at least one weigh-in entry is required';
  END IF;

  v_data := public._pig_feeders_lock();
  FOR i IN 0 .. jsonb_array_length(v_data) - 1 LOOP
    IF COALESCE(btrim(v_data->i->>'id'), '') = p_group_id THEN v_gidx := i; EXIT; END IF;
  END LOOP;
  IF v_gidx < 0 THEN RAISE EXCEPTION 'PROCESSING_VALIDATION: pig group % not found', p_group_id; END IF;
  v_group := v_data->v_gidx;
  v_trips := COALESCE(v_group->'plannedProcessingTrips', '[]'::jsonb);

  -- Lock + validate the weigh-in rows: draft (unsent) pig entries with weights.
  FOR v_w IN
    SELECT w.id, w.weight FROM public.weigh_ins w
     WHERE w.id = ANY(p_weigh_in_ids)
     ORDER BY w.entered_at ASC, w.id ASC
     FOR UPDATE
  LOOP
    NULL;
  END LOOP;
  IF (SELECT count(*) FROM public.weigh_ins w WHERE w.id = ANY(p_weigh_in_ids)) <> v_send THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: one or more weigh-in entries were not found';
  END IF;
  IF EXISTS (SELECT 1 FROM public.weigh_ins w WHERE w.id = ANY(p_weigh_in_ids) AND w.sent_to_trip_id IS NOT NULL) THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: one or more entries were already sent to a trip';
  END IF;
  IF EXISTS (SELECT 1 FROM public.weigh_ins w WHERE w.id = ANY(p_weigh_in_ids)
              AND (w.weight IS NULL OR w.weight <= 0)) THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: every sent entry needs a positive weight';
  END IF;

  -- Chain + target (first trip dated today or later, else earliest).
  SELECT COALESCE(jsonb_agg(t.value ORDER BY t.value->>'date', (t.value->>'order')::numeric NULLS LAST), '[]'::jsonb)
    INTO v_chain
    FROM jsonb_array_elements(v_trips) AS t
   WHERE t.value->>'subBatchId' = p_sub_batch_id AND t.value->>'sex' = p_sex;
  IF jsonb_array_length(v_chain) = 0 THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: no planned trip exists for this sub-batch — create one in /pig/batches first';
  END IF;
  FOR i IN 0 .. jsonb_array_length(v_chain) - 1 LOOP
    IF v_target_idx = -1 AND COALESCE(v_chain->i->>'date', '') >= v_today::text THEN
      v_target_idx := i;
    END IF;
  END LOOP;
  IF v_target_idx = -1 THEN v_target_idx := 0; END IF;
  v_target := v_chain->v_target_idx;

  FOR i IN v_target_idx .. jsonb_array_length(v_chain) - 1 LOOP
    v_available := v_available + COALESCE((v_chain->i->>'plannedCount')::int, 0);
  END LOOP;
  IF v_send > v_available THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: selected pigs exceed the total planned count for this sub-batch';
  END IF;

  -- Consume the chain (target promoted; remainder forward or NEW planned id).
  v_removed := array_append(v_removed, v_target->>'id');
  IF v_send < COALESCE((v_target->>'plannedCount')::int, 0) THEN
    v_remainder := COALESCE((v_target->>'plannedCount')::int, 0) - v_send;
    IF v_target_idx + 1 < jsonb_array_length(v_chain) THEN
      v_adjusted := v_adjusted || jsonb_build_object(
        v_chain->(v_target_idx + 1)->>'id',
        COALESCE((v_chain->(v_target_idx + 1)->>'plannedCount')::int, 0) + v_remainder);
    ELSE
      SELECT COALESCE(max((t.value->>'order')::numeric), -1) INTO v_max_order
        FROM jsonb_array_elements(v_chain) AS t;
      v_new_plan := jsonb_build_object(
        'id', 'pt-' || gen_random_uuid()::text, 'date', v_target->>'date',
        'sex', p_sex, 'subBatchId', p_sub_batch_id,
        'plannedCount', v_remainder, 'order', v_max_order + 1);
    END IF;
  ELSIF v_send > COALESCE((v_target->>'plannedCount')::int, 0) THEN
    v_needed := v_send - COALESCE((v_target->>'plannedCount')::int, 0);
    FOR i IN v_target_idx + 1 .. jsonb_array_length(v_chain) - 1 LOOP
      EXIT WHEN v_needed <= 0;
      v_elem := v_chain->i;
      IF v_needed >= COALESCE((v_elem->>'plannedCount')::int, 0) THEN
        v_removed := array_append(v_removed, v_elem->>'id');
        v_needed := v_needed - COALESCE((v_elem->>'plannedCount')::int, 0);
      ELSE
        v_adjusted := v_adjusted || jsonb_build_object(
          v_elem->>'id', COALESCE((v_elem->>'plannedCount')::int, 0) - v_needed);
        v_needed := 0;
      END IF;
    END LOOP;
    IF v_needed > 0 THEN
      RAISE EXCEPTION 'PROCESSING_VALIDATION: selected pigs exceed the total planned count (chain exhausted)';
    END IF;
  END IF;

  SELECT COALESCE(jsonb_agg(
           CASE WHEN v_adjusted ? (t.value->>'id')
                THEN t.value || jsonb_build_object('plannedCount', (v_adjusted->>(t.value->>'id'))::int)
                ELSE t.value END ORDER BY ord), '[]'::jsonb)
    INTO v_trips
    FROM jsonb_array_elements(v_trips) WITH ORDINALITY AS t(value, ord)
   WHERE NOT (t.value->>'id' = ANY(v_removed));
  IF v_new_plan IS NOT NULL THEN
    v_trips := v_trips || jsonb_build_array(v_new_plan);
  END IF;

  -- Stamp the weigh-ins and build the actual trip (promoted id).
  UPDATE public.weigh_ins
     SET sent_to_trip_id = v_target->>'id', sent_to_group_id = p_group_id
   WHERE id = ANY(p_weigh_in_ids);
  SELECT string_agg(w.weight::text, ' ' ORDER BY w.entered_at ASC, w.id ASC) INTO v_weights
    FROM public.weigh_ins w WHERE w.id = ANY(p_weigh_in_ids);

  SELECT sb.value->>'name' INTO v_sub_name
    FROM jsonb_array_elements(COALESCE(v_group->'subBatches', '[]'::jsonb)) AS sb
   WHERE COALESCE(btrim(sb.value->>'id'), '') = p_sub_batch_id
   LIMIT 1;
  v_actual := jsonb_build_object(
    'id', v_target->>'id', 'date', v_target->>'date', 'pigCount', v_send,
    'liveWeights', COALESCE(v_weights, ''), 'hangingWeight', 0, 'notes', '',
    'subAttributions', jsonb_build_array(jsonb_build_object(
      'subId', p_sub_batch_id, 'subBatchName', COALESCE(v_sub_name, p_sub_batch_id),
      'sex', CASE WHEN p_sex = 'boar' THEN 'Boars' ELSE 'Gilts' END, 'count', v_send)));
  v_actuals := COALESCE(v_group->'processingTrips', '[]'::jsonb) || jsonb_build_array(v_actual);

  v_group := v_group || jsonb_build_object('plannedProcessingTrips', v_trips, 'processingTrips', v_actuals);
  v_data := jsonb_set(v_data, ARRAY[v_gidx::text], v_group);
  PERFORM public._pig_feeders_save(v_data);
  PERFORM public._pig_sync_group_records(v_group);

  IF v_remainder > 0 THEN
    PERFORM public._pig_record_lineage(p_group_id, v_target->>'id',
      jsonb_build_object('event', 'under_send', 'remainder', v_remainder,
        'remainder_trip', COALESCE(v_new_plan->>'id', v_chain->(v_target_idx + 1)->>'id')));
    PERFORM public._pig_record_lineage(p_group_id,
      COALESCE(v_new_plan->>'id', v_chain->(v_target_idx + 1)->>'id'),
      jsonb_build_object('event', 'split_from', 'from_trip', v_target->>'id', 'count', v_remainder));
  ELSIF v_send > COALESCE((v_target->>'plannedCount')::int, 0) THEN
    PERFORM public._pig_record_lineage(p_group_id, v_target->>'id',
      jsonb_build_object('event', 'over_send', 'consumed_trips', to_jsonb(v_removed[2:]),
        'sent', v_send));
  END IF;

  RETURN jsonb_build_object('ok', true, 'trip_id', v_target->>'id',
                            'trip_date', v_target->>'date', 'sent', v_send,
                            'remainder', v_remainder,
                            'remainder_trip_id', CASE WHEN v_remainder > 0
                              THEN COALESCE(v_new_plan->>'id', v_chain->(v_target_idx + 1)->>'id') END);
END
$fn$;
REVOKE ALL ON FUNCTION public.pig_send_to_trip(text, text, text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pig_send_to_trip(text, text, text, text[]) TO authenticated;

-- Undo one sent weigh-in entry. Returns the pig to the planned chain (next
-- upcoming trip, else a new planned trip); an emptied actual trip reverts to
-- a PLANNED trip with the SAME id, so the Processing record keeps its
-- identity and flips back to the planned phase.
CREATE OR REPLACE FUNCTION public.pig_undo_send(p_weigh_in_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_w RECORD;
  v_data jsonb; v_gidx int := -1; v_group jsonb;
  v_trip jsonb; v_tidx int := -1;
  v_planned jsonb; v_actuals jsonb;
  v_attr jsonb; v_sub_id text; v_sex text;
  v_weights text[]; v_removed boolean := false;
  v_chain jsonb; v_recipient jsonb; v_max_order numeric := -1;
  i int; v_out text[];
BEGIN
  PERFORM public._pig_require_manager();
  -- Lock ORDER matters: feeders store row FIRST, weigh_ins rows second — the
  -- same order pig_send_to_trip / trip edit / trip delete use, so concurrent
  -- send + undo cannot deadlock.
  v_data := public._pig_feeders_lock();
  SELECT id, weight, sent_to_trip_id, sent_to_group_id INTO v_w
    FROM public.weigh_ins WHERE id = p_weigh_in_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROCESSING_VALIDATION: weigh-in entry not found'; END IF;
  IF v_w.sent_to_trip_id IS NULL THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: entry is not sent to a trip';
  END IF;

  FOR i IN 0 .. jsonb_array_length(v_data) - 1 LOOP
    IF COALESCE(btrim(v_data->i->>'id'), '') = COALESCE(v_w.sent_to_group_id, '') THEN v_gidx := i; EXIT; END IF;
  END LOOP;
  IF v_gidx < 0 THEN
    -- Dangling stamp (group gone): repair the weigh-in and stop.
    UPDATE public.weigh_ins SET sent_to_trip_id = NULL, sent_to_group_id = NULL WHERE id = p_weigh_in_id;
    RETURN jsonb_build_object('ok', true, 'repaired', true);
  END IF;
  v_group := v_data->v_gidx;
  v_actuals := COALESCE(v_group->'processingTrips', '[]'::jsonb);
  FOR i IN 0 .. jsonb_array_length(v_actuals) - 1 LOOP
    IF COALESCE(btrim(v_actuals->i->>'id'), '') = v_w.sent_to_trip_id THEN v_tidx := i; EXIT; END IF;
  END LOOP;
  IF v_tidx < 0 THEN
    UPDATE public.weigh_ins SET sent_to_trip_id = NULL, sent_to_group_id = NULL WHERE id = p_weigh_in_id;
    RETURN jsonb_build_object('ok', true, 'repaired', true);
  END IF;
  v_trip := v_actuals->v_tidx;
  v_planned := COALESCE(v_group->'plannedProcessingTrips', '[]'::jsonb);

  -- Resolve the sub/sex from the trip's single attribution when unambiguous.
  v_attr := COALESCE(v_trip->'subAttributions', '[]'::jsonb);
  IF jsonb_array_length(v_attr) = 1 THEN
    v_sub_id := v_attr->0->>'subId';
    v_sex := CASE WHEN lower(COALESCE(v_attr->0->>'sex','')) LIKE 'boar%' THEN 'boar' ELSE 'gilt' END;
  END IF;

  IF COALESCE((v_trip->>'pigCount')::int, 0) <= 1 THEN
    -- Last pig: the actual trip reverts to a PLANNED trip with the SAME id.
    v_removed := true;
    SELECT COALESCE(jsonb_agg(t.value ORDER BY ord), '[]'::jsonb) INTO v_actuals
      FROM jsonb_array_elements(v_actuals) WITH ORDINALITY AS t(value, ord)
     WHERE t.value->>'id' <> (v_trip->>'id');
    IF v_sub_id IS NOT NULL THEN
      SELECT COALESCE(max((t.value->>'order')::numeric), -1) INTO v_max_order
        FROM jsonb_array_elements(v_planned) AS t
       WHERE t.value->>'subBatchId' = v_sub_id AND t.value->>'sex' = v_sex;
      v_planned := v_planned || jsonb_build_array(jsonb_build_object(
        'id', v_trip->>'id', 'date', v_trip->>'date', 'sex', v_sex,
        'subBatchId', v_sub_id, 'plannedCount', 1, 'order', v_max_order + 1));
    END IF;
  ELSE
    -- Remove one weight instance + decrement counts.
    v_weights := string_to_array(COALESCE(v_trip->>'liveWeights', ''), ' ');
    v_out := ARRAY[]::text[];
    v_removed := false;
    FOR i IN 1 .. COALESCE(array_length(v_weights, 1), 0) LOOP
      IF NOT v_removed AND btrim(v_weights[i]) ~ '^\d+(\.\d+)?$'
         AND btrim(v_weights[i])::numeric = v_w.weight THEN
        v_removed := true; -- drop the first matching instance
      ELSE
        v_out := array_append(v_out, v_weights[i]);
      END IF;
    END LOOP;
    v_trip := v_trip || jsonb_build_object(
      'pigCount', COALESCE((v_trip->>'pigCount')::int, 0) - 1,
      'liveWeights', array_to_string(v_out, ' '));
    IF jsonb_array_length(v_attr) = 1 THEN
      v_trip := v_trip || jsonb_build_object('subAttributions', jsonb_build_array(
        v_attr->0 || jsonb_build_object('count', GREATEST(COALESCE((v_attr->0->>'count')::int, 1) - 1, 0))));
    END IF;
    v_actuals := jsonb_set(v_actuals, ARRAY[v_tidx::text], v_trip);
    v_removed := false;

    -- Return the pig to the plan when the chain is resolvable.
    IF v_sub_id IS NOT NULL THEN
      SELECT COALESCE(jsonb_agg(t.value ORDER BY t.value->>'date', (t.value->>'order')::numeric NULLS LAST), '[]'::jsonb)
        INTO v_chain
        FROM jsonb_array_elements(v_planned) AS t
       WHERE t.value->>'subBatchId' = v_sub_id AND t.value->>'sex' = v_sex;
      v_recipient := NULL;
      FOR i IN 0 .. jsonb_array_length(v_chain) - 1 LOOP
        IF v_recipient IS NULL AND COALESCE(v_chain->i->>'date', '') >= COALESCE(v_trip->>'date', '') THEN
          v_recipient := v_chain->i;
        END IF;
      END LOOP;
      IF v_recipient IS NULL AND jsonb_array_length(v_chain) > 0 THEN
        v_recipient := v_chain->(jsonb_array_length(v_chain) - 1);
      END IF;
      IF v_recipient IS NOT NULL THEN
        SELECT COALESCE(jsonb_agg(
                 CASE WHEN t.value->>'id' = v_recipient->>'id'
                      THEN t.value || jsonb_build_object('plannedCount', COALESCE((t.value->>'plannedCount')::int, 0) + 1)
                      ELSE t.value END ORDER BY ord), '[]'::jsonb)
          INTO v_planned
          FROM jsonb_array_elements(v_planned) WITH ORDINALITY AS t(value, ord);
      ELSE
        SELECT COALESCE(max((t.value->>'order')::numeric), -1) INTO v_max_order
          FROM jsonb_array_elements(v_planned) AS t
         WHERE t.value->>'subBatchId' = v_sub_id AND t.value->>'sex' = v_sex;
        v_planned := v_planned || jsonb_build_array(jsonb_build_object(
          'id', 'pt-' || gen_random_uuid()::text, 'date', v_trip->>'date', 'sex', v_sex,
          'subBatchId', v_sub_id, 'plannedCount', 1, 'order', v_max_order + 1));
      END IF;
    END IF;
  END IF;

  UPDATE public.weigh_ins SET sent_to_trip_id = NULL, sent_to_group_id = NULL WHERE id = p_weigh_in_id;
  v_group := v_group || jsonb_build_object('plannedProcessingTrips', v_planned, 'processingTrips', v_actuals);
  v_data := jsonb_set(v_data, ARRAY[v_gidx::text], v_group);
  PERFORM public._pig_feeders_save(v_data);
  PERFORM public._pig_record_lineage(COALESCE(v_w.sent_to_group_id, ''), v_w.sent_to_trip_id,
    jsonb_build_object('event', 'undo_send', 'weigh_in_id', p_weigh_in_id));
  PERFORM public._pig_sync_group_records(v_group);
  RETURN jsonb_build_object('ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.pig_undo_send(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pig_undo_send(text) TO authenticated;

-- Edit an actual trip's planner-owned facts. For trips with linked weigh-ins,
-- pigCount/liveWeights are recomputed from the weigh-ins (authoritative);
-- explicit values only apply to legacy trips with no linked entries.
CREATE OR REPLACE FUNCTION public.pig_update_processing_trip(
  p_group_id text, p_trip_id text,
  p_date text DEFAULT NULL, p_hanging_weight numeric DEFAULT NULL,
  p_notes text DEFAULT NULL, p_pig_count int DEFAULT NULL, p_live_weights text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_data jsonb; v_gidx int := -1; v_group jsonb; v_actuals jsonb;
  v_trip jsonb; v_tidx int := -1; i int;
  v_linked int; v_weights text;
BEGIN
  PERFORM public._pig_require_manager();
  IF p_date IS NOT NULL AND p_date !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: date must be YYYY-MM-DD';
  END IF;
  v_data := public._pig_feeders_lock();
  FOR i IN 0 .. jsonb_array_length(v_data) - 1 LOOP
    IF COALESCE(btrim(v_data->i->>'id'), '') = p_group_id THEN v_gidx := i; EXIT; END IF;
  END LOOP;
  IF v_gidx < 0 THEN RAISE EXCEPTION 'PROCESSING_VALIDATION: pig group % not found', p_group_id; END IF;
  v_group := v_data->v_gidx;
  v_actuals := COALESCE(v_group->'processingTrips', '[]'::jsonb);
  FOR i IN 0 .. jsonb_array_length(v_actuals) - 1 LOOP
    IF COALESCE(btrim(v_actuals->i->>'id'), '') = p_trip_id THEN v_tidx := i; EXIT; END IF;
  END LOOP;
  IF v_tidx < 0 THEN RAISE EXCEPTION 'PROCESSING_VALIDATION: processing trip % not found', p_trip_id; END IF;
  v_trip := v_actuals->v_tidx;

  IF p_date IS NOT NULL THEN v_trip := v_trip || jsonb_build_object('date', p_date); END IF;
  IF p_hanging_weight IS NOT NULL THEN v_trip := v_trip || jsonb_build_object('hangingWeight', p_hanging_weight); END IF;
  IF p_notes IS NOT NULL THEN v_trip := v_trip || jsonb_build_object('notes', p_notes); END IF;

  SELECT count(*), string_agg(w.weight::text, ' ' ORDER BY w.entered_at ASC, w.id ASC)
    INTO v_linked, v_weights
    FROM public.weigh_ins w
   WHERE w.sent_to_trip_id = p_trip_id AND w.sent_to_group_id = p_group_id;
  IF v_linked > 0 THEN
    v_trip := v_trip || jsonb_build_object('pigCount', v_linked, 'liveWeights', COALESCE(v_weights, ''));
  ELSE
    IF p_pig_count IS NOT NULL THEN v_trip := v_trip || jsonb_build_object('pigCount', p_pig_count); END IF;
    IF p_live_weights IS NOT NULL THEN v_trip := v_trip || jsonb_build_object('liveWeights', p_live_weights); END IF;
  END IF;

  v_actuals := jsonb_set(v_actuals, ARRAY[v_tidx::text], v_trip);
  v_group := v_group || jsonb_build_object('processingTrips', v_actuals);
  v_data := jsonb_set(v_data, ARRAY[v_gidx::text], v_group);
  PERFORM public._pig_feeders_save(v_data);
  PERFORM public._pig_sync_group_records(v_group);
  RETURN jsonb_build_object('ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.pig_update_processing_trip(text, text, text, numeric, text, int, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pig_update_processing_trip(text, text, text, numeric, text, int, text) TO authenticated;

-- Delete an actual trip. Clears dangling weigh-in stamps in the same
-- transaction; the trip's Processing record follows the worked-archive vs
-- empty-remove rule through the group sync.
CREATE OR REPLACE FUNCTION public.pig_delete_processing_trip(p_group_id text, p_trip_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_data jsonb; v_gidx int := -1; v_group jsonb; v_actuals jsonb;
  v_found boolean := false; i int; v_cleared int;
BEGIN
  PERFORM public._pig_require_manager();
  v_data := public._pig_feeders_lock();
  FOR i IN 0 .. jsonb_array_length(v_data) - 1 LOOP
    IF COALESCE(btrim(v_data->i->>'id'), '') = p_group_id THEN v_gidx := i; EXIT; END IF;
  END LOOP;
  IF v_gidx < 0 THEN RAISE EXCEPTION 'PROCESSING_VALIDATION: pig group % not found', p_group_id; END IF;
  v_group := v_data->v_gidx;
  -- Existence check BEFORE filtering (a bool_or over the filtered rows would
  -- never see the target).
  SELECT bool_or(t.value->>'id' = p_trip_id) INTO v_found
    FROM jsonb_array_elements(COALESCE(v_group->'processingTrips', '[]'::jsonb)) AS t;
  IF NOT COALESCE(v_found, false) THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: processing trip % not found', p_trip_id;
  END IF;
  SELECT COALESCE(jsonb_agg(t.value ORDER BY ord), '[]'::jsonb)
    INTO v_actuals
    FROM jsonb_array_elements(COALESCE(v_group->'processingTrips', '[]'::jsonb))
           WITH ORDINALITY AS t(value, ord)
   WHERE t.value->>'id' <> p_trip_id;

  UPDATE public.weigh_ins
     SET sent_to_trip_id = NULL, sent_to_group_id = NULL
   WHERE sent_to_trip_id = p_trip_id AND sent_to_group_id = p_group_id;
  GET DIAGNOSTICS v_cleared = ROW_COUNT;

  PERFORM public._pig_record_lineage(p_group_id, p_trip_id,
    jsonb_build_object('event', 'trip_deleted', 'weigh_ins_released', v_cleared));

  v_group := v_group || jsonb_build_object('processingTrips', v_actuals);
  v_data := jsonb_set(v_data, ARRAY[v_gidx::text], v_group);
  PERFORM public._pig_feeders_save(v_data);
  PERFORM public._pig_sync_group_records(v_group);
  RETURN jsonb_build_object('ok', true, 'weigh_ins_released', v_cleared);
END
$fn$;
REVOKE ALL ON FUNCTION public.pig_delete_processing_trip(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pig_delete_processing_trip(text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
