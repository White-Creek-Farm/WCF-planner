-- ============================================================================
-- 178_processing_legacy_liveweights.sql
-- Processing read-path hotfix, two repairs in one migration:
--
-- 1. LEGACY PIG LIVEWEIGHTS PARSER (crash repair)
--    get_processing_record failed closed on comma-separated legacy Pig
--    liveWeights (PROD record prc-2423daec-f77d-4409-9f72-02cc9a9f7a4d,
--    stored string "315, 305, 280, 280, 275" -> SQL token "315," -> invalid
--    input syntax for type numeric). Migration 176's _processing_animal_detail
--    split the trip's legacy string on single spaces and cast every nonblank
--    token straight to numeric, while the canonical client parser
--    (parseLiveWeights, src/lib/pig.js) treats commas AND all whitespace as
--    separators and keeps only positive finite weights. The reissued pig
--    fallback below mirrors that client contract:
--      - splits on [\s,]+ (commas + all whitespace, runs collapse);
--      - keeps a token only when strictly numeric (^\d+(\.\d+)?$ — the same
--        validation regex migration 176's pig_undo_send already uses) AND
--        positive; the cast sits inside a CASE guard so an invalid token can
--        never reach ::numeric regardless of planner predicate order;
--      - excludes malformed/empty/zero/negative tokens instead of crashing
--        or silently reinterpreting them;
--      - preserves source order via split ordinality;
--      - returns '[]' when nothing valid remains (UI shows its existing
--        "No live weights recorded" state);
--      - keeps linked weigh-ins authoritative: the fallback still runs only
--        when the trip has zero linked weigh-ins.
--    The cattle/sheep branches are unchanged from migration 176. Stored
--    legacy liveWeights strings are not rewritten.
--
-- 2. CANONICAL CURRENT DISPLAY TITLE (stale source-name repair)
--    processing_records.title is a stored snapshot refreshed only when the
--    planner reconcile runs, so between a source rename and the next
--    reconcile every stored-title consumer showed the old name (live Sheep
--    example: list/source details L-26-01 vs drawer header stale S-26-01).
--    _processing_current_title(p_rec, p_projection default null) is the one
--    canonical display-title contract:
--      - milestone / historical / import-only records: stored title;
--      - archived or source-removed records: stored title;
--      - planner-backed broiler/cattle/sheep: current source batch name;
--      - planner-backed pig: Pig Trip · <current batch name> · Trip <stable
--        trip_ordinal> (same convention the reconcile writes);
--      - missing/unmatched source or blank source name: stored title.
--    It reuses _processing_source_projection (no second implementation of
--    the four source lookups) and accepts a pre-computed projection so list
--    and get never evaluate the projection twice per row. Reissued consumers:
--      - list_processing_records: title is now the canonical current title;
--        source projection and search behavior unchanged;
--      - get_processing_record: returned record.title is overridden with the
--        canonical current title; role gate, source, animals, subtasks,
--        attachments, completion blockers, and shape unchanged;
--      - list_my_processing_subtasks: returns/sorts by the canonical title;
--      - _processing_notify_assignment: new assignment notifications embed
--        the canonical current title.
--    The stored-title update inside planner reconciliation is preserved and
--    untouched. Historical Activity bodies, existing notifications, comments,
--    attachments, and audit history are not rewritten.
--
-- No table, RLS, policy, storage, or data change. All exposed RPC
-- signatures and grants are preserved. PostgREST NOTIFY included.
-- ============================================================================

-- ── 1. Per-animal detail (parser repair) ─────────────────────────────────────
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
    -- Legacy free-form parse mirroring the canonical client parser
    -- (parseLiveWeights, src/lib/pig.js): commas and all whitespace are
    -- separators; only strictly-numeric positive tokens survive, in source
    -- order. The CASE guard makes the numeric cast unreachable for invalid
    -- tokens, so malformed legacy text can never crash the record read.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'weigh_in_id', NULL,
             'live_weight', t.w
           ) ORDER BY t.ord), '[]'::jsonb)
      INTO v_out
      FROM (
        SELECT x.ord,
               CASE WHEN x.wt ~ '^\d+(\.\d+)?$' THEN x.wt::numeric END AS w
          FROM unnest(regexp_split_to_array(COALESCE(v_t->>'liveWeights', ''), '[\s,]+'))
               WITH ORDINALITY AS x(wt, ord)
      ) t
     WHERE t.w > 0;
    RETURN v_out;
  END IF;

  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public._processing_animal_detail(public.processing_records) FROM PUBLIC, anon, authenticated;

-- ── 2. Canonical current display title ───────────────────────────────────────
-- The ONE display-title contract for Processing records. Planner-backed rows
-- derive their title from the CURRENT source name at read time (renames show
-- immediately, independent of reconcile cadence); everything else keeps the
-- stored Processing-owned title. Callers that already computed the row's
-- source projection pass it as p_projection so it is never evaluated twice.
CREATE OR REPLACE FUNCTION public._processing_current_title(
  p_rec public.processing_records, p_projection jsonb DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE
AS $fn$
DECLARE
  v_proj jsonb;
  v_name text;
BEGIN
  -- Milestones, historical/import-only rows, and dormant (archived /
  -- source-removed) planner rows keep their stored title.
  IF p_rec.record_type <> 'planner_batch'
     OR p_rec.source_kind IS NULL OR p_rec.source_id IS NULL
     OR p_rec.archived OR p_rec.source_removed_at IS NOT NULL THEN
    RETURN p_rec.title;
  END IF;
  v_proj := COALESCE(p_projection, public._processing_source_projection(p_rec));
  IF v_proj IS NULL OR COALESCE((v_proj->>'matched')::boolean, false) = false THEN
    RETURN p_rec.title; -- missing/removed source keeps the stored title
  END IF;
  v_name := NULLIF(btrim(COALESCE(v_proj->>'batch_name', '')), '');
  IF v_name IS NULL THEN
    RETURN p_rec.title; -- blank source name keeps the stored title
  END IF;
  IF p_rec.source_kind = 'pig' THEN
    -- Same convention the planner reconcile writes into the stored title.
    RETURN 'Pig Trip · ' || v_name || ' · Trip ' || COALESCE(p_rec.trip_ordinal, 0);
  END IF;
  RETURN v_name;
END
$fn$;
REVOKE ALL ON FUNCTION public._processing_current_title(public.processing_records, jsonb) FROM PUBLIC, anon, authenticated;

-- ── 3. list_processing_records: canonical title (176 base) ──────────────────
-- Only delta vs 176: 'title' is the canonical current title, reusing the
-- row's already-computed source projection (no second projection eval).
-- Source projection, search_text, ordering, and shape are unchanged.
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
      'id', r.id, 'record_type', r.record_type, 'program', r.program,
      'title', public._processing_current_title(r, src.projection),
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

-- ── 4. get_processing_record: canonical title (176 base) ────────────────────
-- Deltas vs 176: the source projection is computed ONCE into v_src (it was
-- already returned as 'source') and the returned record.title is overridden
-- with the canonical current title. Role gate, animals, subtasks,
-- attachments, completion blockers, signature, grants, and the fail-closed
-- NULL-on-missing behavior are unchanged.
CREATE OR REPLACE FUNCTION public.get_processing_record(p_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE
AS $fn$
DECLARE
  v_row  public.processing_records;
  v_rec  jsonb;
  v_src  jsonb;
  v_subs jsonb;
  v_atts jsonb;
  v_blockers text[];
BEGIN
  PERFORM public._processing_require_operational();
  SELECT * INTO v_row FROM public.processing_records WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  v_src := public._processing_source_projection(v_row);
  v_rec := to_jsonb(v_row) || jsonb_build_object(
    'title', public._processing_current_title(v_row, v_src),
    'effective_status', public._processing_effective_status(v_row),
    'source', v_src,
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

-- ── 5. list_my_processing_subtasks: canonical title (175 base) ──────────────
-- Only delta vs 175: record_title returns — and the aggregate sorts by — the
-- canonical current title (computed once per row in a lateral).
CREATE OR REPLACE FUNCTION public.list_my_processing_subtasks()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE
AS $fn$
DECLARE v_role text; v_out jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'list_my_processing_subtasks: authenticated caller required';
  END IF;
  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('farm_team', 'management', 'admin') THEN
    RETURN '[]'::jsonb;
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'subtask_id',      s.id,
           'label',           s.label,
           'sort_order',      s.sort_order,
           'record_id',       r.id,
           'record_title',    ct.title,
           'program',         r.program,
           'processing_date', r.processing_date,
           'record_type',     r.record_type
         ) ORDER BY r.processing_date ASC NULLS LAST, ct.title ASC, s.sort_order ASC), '[]'::jsonb)
    INTO v_out
    FROM public.processing_subtasks s
    JOIN public.processing_records r ON r.id = s.record_id
    LEFT JOIN LATERAL (
      SELECT public._processing_current_title(r) AS title
    ) ct ON true
   WHERE s.assignee_profile_id = auth.uid()
     AND s.done = false
     AND r.archived = false
     AND r.record_type <> 'import_exception';
  RETURN v_out;
END
$fn$;
REVOKE ALL ON FUNCTION public.list_my_processing_subtasks() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_my_processing_subtasks() TO authenticated;

-- ── 6. _processing_notify_assignment: canonical title (177 base) ────────────
-- Only delta vs 177: the notification body embeds the canonical CURRENT
-- record title instead of the stale stored snapshot. Idempotence,
-- self-assignment suppression, best-effort insert, and existing notification
-- rows are unchanged; historical Activity bodies are never rewritten.
CREATE OR REPLACE FUNCTION public._processing_notify_assignment(
  p_subtask_id text, p_record_id text, p_recipient uuid, p_label text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_title text;
  v_event text;
BEGIN
  IF p_recipient IS NULL OR p_recipient = v_actor THEN RETURN; END IF;
  SELECT public._processing_current_title(r) INTO v_title
    FROM public.processing_records r WHERE r.id = p_record_id;
  v_event := public._processing_emit_activity_returning(
    p_record_id, 'field.updated',
    'Assigned processing work: ' || COALESCE(p_label, ''),
    jsonb_build_object('action', 'assign_subtask', 'subtask_id', p_subtask_id,
                       'assignee_profile_id', p_recipient));
  BEGIN
    INSERT INTO public.notifications
      (id, recipient_profile_id, actor_profile_id, type, title, body, activity_event_id)
    VALUES ('ntf-' || gen_random_uuid()::text, p_recipient, v_actor,
            'processing_subtask_assigned',
            'Processing work assigned',
            left(COALESCE(p_label, '') || CASE WHEN v_title IS NULL THEN '' ELSE ' — ' || v_title END, 200),
            v_event);
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'processing assignment notification failed: %', SQLERRM;
  END;
END
$fn$;
REVOKE ALL ON FUNCTION public._processing_notify_assignment(text, text, uuid, text) FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
