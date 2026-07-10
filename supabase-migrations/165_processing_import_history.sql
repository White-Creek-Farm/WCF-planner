-- ============================================================================
-- 165_processing_import_history.sql
-- ----------------------------------------------------------------------------
-- Importer completeness: imported Asana SYSTEM stories become immutable
-- Processing historical Activity, imported comments carry profile-mapped
-- mentions, and imported assignees are profile-mapped (by Asana user gid/email,
-- resolved Edge-side) without ever clobbering a local assignment.
--
-- 1. record_processing_history_event (service_role) — one Asana SYSTEM story →
--    one activity_events row on the linked processing.record with the ORIGINAL
--    timestamp and a DETERMINISTIC id ('ae-asana-<story_gid>') so re-runs are
--    idempotent. actor_profile_id stays NULL (the actor is named in the body /
--    payload, not impersonated). event_type 'imported.system'.
-- 2. record_processing_comment REISSUE — adds optional p_row.mentions (array of
--    profile uuids, resolved Edge-side from Asana profile links). Mentions are
--    display-only on import: this path writes comments directly and never
--    touches the notification tables, so historical mentions cannot notify.
--    A re-offer for an ALREADY-imported comment backfills mentions when the
--    stored row has none (so sync_activity can upgrade the comments imported
--    before mention mapping existed) — body/author/timestamps stay immutable.
-- 3. upsert_processing_subtask_from_asana REISSUE — adds assignee_profile_id
--    mapping. Local ownership rules:
--      • done/completed_at stay gated on done_locally_set (mig 157, preserved).
--      • assignee: Asana may set it ONLY while no LOCAL profile assignment
--        exists (assignee_profile_id IS NULL); a local reassignment wins over
--        every later import.
-- 4. upsert_processing_from_asana REISSUE — imported records also carry the
--    Asana assignee (assignee_name + optional mapped assignee_profile_id),
--    again only while not locally assigned.
--
-- Error class: deterministic failures use 'PROCESSING_VALIDATION:'.
-- NO BEGIN/COMMIT (TEST applies via exec_sql; PROD via psql --single-transaction).
-- Depends on: 156/157 (domain + links + importer RPCs), 164 (assignee columns).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── 1. Imported system stories → immutable historical Activity ───────────────
CREATE OR REPLACE FUNCTION public.record_processing_history_event(p_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_gid    text := p_row->>'asana_story_gid';
  v_rec_id text;
  v_id     text;
BEGIN
  IF v_gid IS NULL OR btrim(v_gid) = '' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: asana_story_gid required';
  END IF;
  SELECT processing_record_id INTO v_rec_id
    FROM public.processing_asana_links
   WHERE asana_gid = p_row->>'parent_asana_gid' AND processing_record_id IS NOT NULL;
  IF v_rec_id IS NULL THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: parent record not linked for history event';
  END IF;
  v_id := 'ae-asana-' || v_gid;
  IF EXISTS (SELECT 1 FROM public.activity_events WHERE id = v_id) THEN
    RETURN jsonb_build_object('id', v_id, 'action', 'skipped', 'reason', 'already imported');
  END IF;
  INSERT INTO public.activity_events
    (id, entity_type, entity_id, actor_profile_id, event_type, body, payload, created_at)
  VALUES (
    v_id, 'processing.record', v_rec_id, NULL, 'imported.system',
    COALESCE(NULLIF(btrim(COALESCE(p_row->>'body', '')), ''), '(system event)'),
    jsonb_build_object(
      'imported', true,
      'source', 'asana',
      'asana_story_gid', v_gid,
      'original_author_name', p_row->>'original_author_name'),
    COALESCE((p_row->>'created_at')::timestamptz, now())
  );
  RETURN jsonb_build_object('id', v_id, 'action', 'inserted');
END
$fn$;
REVOKE ALL ON FUNCTION public.record_processing_history_event(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_processing_history_event(jsonb) TO service_role;

-- ── 2. Imported comments: profile-mapped mentions (display-only) ─────────────
CREATE OR REPLACE FUNCTION public.record_processing_comment(p_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_gid text := p_row->>'asana_comment_gid';
  v_rec_id text;
  v_id text;
  v_mentions uuid[] := ARRAY[]::uuid[];
  v_m jsonb;
BEGIN
  SELECT processing_record_id INTO v_rec_id
    FROM public.processing_asana_links
   WHERE asana_gid = p_row->>'parent_asana_gid' AND processing_record_id IS NOT NULL;
  IF v_rec_id IS NULL THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: parent record not linked for comment';
  END IF;
  -- Mentions: accept only well-formed uuids that resolve to a real profile.
  -- Import-path comments never write notifications, so these are display-only.
  IF jsonb_typeof(COALESCE(p_row->'mentions', 'null'::jsonb)) = 'array' THEN
    FOR v_m IN SELECT e FROM jsonb_array_elements(p_row->'mentions') AS e LOOP
      IF jsonb_typeof(v_m) = 'string'
         AND (v_m #>> '{}') ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'
         AND EXISTS (SELECT 1 FROM public.profiles WHERE id = (v_m #>> '{}')::uuid) THEN
        v_mentions := array_append(v_mentions, (v_m #>> '{}')::uuid);
      END IF;
    END LOOP;
  END IF;
  IF v_gid IS NOT NULL AND EXISTS (SELECT 1 FROM public.comments WHERE asana_comment_gid = v_gid) THEN
    -- Mention backfill for a previously-imported comment: only when the stored
    -- row has no mentions yet; everything else stays immutable.
    IF array_length(v_mentions, 1) IS NOT NULL THEN
      UPDATE public.comments
         SET mentions = v_mentions
       WHERE asana_comment_gid = v_gid
         AND COALESCE(array_length(mentions, 1), 0) = 0;
      IF FOUND THEN
        RETURN jsonb_build_object('action', 'mentions_backfilled');
      END IF;
    END IF;
    RETURN jsonb_build_object('action', 'skipped', 'reason', 'already imported');
  END IF;
  v_id := COALESCE(p_row->>'id', 'cmt-' || gen_random_uuid()::text);
  INSERT INTO public.comments
    (id, entity_type, entity_id, author_profile_id, body, mentions, attachments,
     source, is_imported, original_author_name, asana_comment_gid, created_at)
  VALUES (
    v_id, 'processing.record', v_rec_id, NULL,
    COALESCE(p_row->>'body', ''), v_mentions, '[]'::jsonb,
    'asana', true, p_row->>'original_author_name', v_gid,
    COALESCE((p_row->>'created_at')::timestamptz, now())
  );
  RETURN jsonb_build_object('id', v_id, 'action', 'inserted');
END
$fn$;
REVOKE ALL ON FUNCTION public.record_processing_comment(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_processing_comment(jsonb) TO service_role;

-- ── 3. Subtask importer: profile-mapped assignee, local ownership preserved ──
CREATE OR REPLACE FUNCTION public.upsert_processing_subtask_from_asana(p_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_gid    text := p_row->>'asana_gid';
  v_rec_id text;
  v_id     text;
  v_exists boolean;
  v_pid    uuid := NULL;
BEGIN
  IF v_gid IS NULL OR btrim(v_gid) = '' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: subtask asana_gid required';
  END IF;
  SELECT processing_record_id INTO v_rec_id
    FROM public.processing_asana_links
   WHERE asana_gid = p_row->>'parent_asana_gid' AND processing_record_id IS NOT NULL;
  IF v_rec_id IS NULL THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: parent record not linked for subtask';
  END IF;
  IF p_row->>'assignee_profile_id' ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'
     AND EXISTS (SELECT 1 FROM public.profiles WHERE id = (p_row->>'assignee_profile_id')::uuid) THEN
    v_pid := (p_row->>'assignee_profile_id')::uuid;
  END IF;
  SELECT id INTO v_id FROM public.processing_subtasks WHERE asana_gid = v_gid;
  v_exists := FOUND;
  IF v_exists THEN
    UPDATE public.processing_subtasks SET
      record_id    = v_rec_id,
      label        = COALESCE(p_row->>'label', label),
      -- Asana may (re)state the assignee ONLY while no LOCAL profile assignment
      -- exists; a local reassignment (assignee_profile_id set by an operator)
      -- wins over every later import.
      assignee     = CASE WHEN assignee_profile_id IS NOT NULL THEN assignee
                          ELSE COALESCE(p_row->>'assignee', assignee) END,
      assignee_profile_id = CASE WHEN assignee_profile_id IS NOT NULL THEN assignee_profile_id
                                 ELSE COALESCE(v_pid, assignee_profile_id) END,
      -- Asana can only set done while the item has NOT been locally toggled
      -- (mig 157 rule, preserved verbatim).
      done         = CASE WHEN done_locally_set THEN done
                          ELSE COALESCE((p_row->>'done')::boolean, done) END,
      completed_at = CASE WHEN done_locally_set THEN completed_at
                          ELSE COALESCE((p_row->>'completed_at')::timestamptz, completed_at) END,
      due_on       = COALESCE((p_row->>'due_on')::date, due_on),
      start_on     = COALESCE((p_row->>'start_on')::date, start_on),
      sort_order   = COALESCE((p_row->>'sort_order')::int, sort_order),
      updated_at   = now()
    WHERE id = v_id;
    RETURN jsonb_build_object('id', v_id, 'action', 'updated');
  END IF;
  v_id := COALESCE(p_row->>'id', 'pst-' || gen_random_uuid()::text);
  INSERT INTO public.processing_subtasks
    (id, record_id, label, assignee, assignee_profile_id, done, completed_at, asana_gid,
     due_on, start_on, sort_order, source, created_by)
  VALUES (
    v_id, v_rec_id, COALESCE(p_row->>'label', '(untitled)'), p_row->>'assignee', v_pid,
    COALESCE((p_row->>'done')::boolean, false), (p_row->>'completed_at')::timestamptz, v_gid,
    (p_row->>'due_on')::date, (p_row->>'start_on')::date,
    COALESCE((p_row->>'sort_order')::int, 0), 'asana', public._processing_import_actor()
  );
  RETURN jsonb_build_object('id', v_id, 'action', 'inserted');
END
$fn$;
REVOKE ALL ON FUNCTION public.upsert_processing_subtask_from_asana(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_processing_subtask_from_asana(jsonb) TO service_role;

-- ── 4. Record importer: carry the Asana assignee (never over a local one) ────
CREATE OR REPLACE FUNCTION public.upsert_processing_from_asana(p_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_gid   text := p_row->>'asana_gid';
  v_id    text;
  v_exists boolean;
  v_action text;
  v_type  text := COALESCE(p_row->>'record_type', 'asana_historical');
  v_ms    text;
  v_pid   uuid := NULL;
BEGIN
  IF v_gid IS NULL OR btrim(v_gid) = '' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: asana_gid required for import';
  END IF;
  IF v_type = 'planner_batch' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: Asana import may not create planner_batch records';
  END IF;
  v_ms := CASE lower(COALESCE(p_row->>'match_status', ''))
            WHEN 'native'       THEN 'native'
            WHEN 'matched'      THEN 'matched'
            WHEN 'review'       THEN 'review'
            WHEN 'needs_review' THEN 'review'
            WHEN ''             THEN NULL
            ELSE 'unmatched'
          END;
  IF p_row->>'assignee_profile_id' ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'
     AND EXISTS (SELECT 1 FROM public.profiles WHERE id = (p_row->>'assignee_profile_id')::uuid) THEN
    v_pid := (p_row->>'assignee_profile_id')::uuid;
  END IF;
  SELECT id INTO v_id FROM public.processing_records WHERE asana_gid = v_gid;
  v_exists := FOUND;
  IF NOT v_exists THEN
    v_id := COALESCE(p_row->>'id', 'prc-' || gen_random_uuid()::text);
  END IF;

  IF v_exists THEN
    UPDATE public.processing_records SET
      record_type        = COALESCE(p_row->>'record_type', record_type),
      program            = COALESCE(p_row->>'program', program),
      title              = COALESCE(p_row->>'title', title),
      processing_date    = COALESCE((p_row->>'processing_date')::date, processing_date),
      status             = COALESCE(p_row->>'status', status),
      number_processed   = COALESCE((p_row->>'number_processed')::int, number_processed),
      -- Imported assignee only while not locally assigned (local wins forever).
      assignee_name      = CASE WHEN assignee_profile_id IS NOT NULL THEN assignee_name
                                ELSE COALESCE(p_row->>'assignee_name', assignee_name) END,
      assignee_profile_id = CASE WHEN assignee_profile_id IS NOT NULL THEN assignee_profile_id
                                 ELSE COALESCE(v_pid, assignee_profile_id) END,
      asana_project_gid  = COALESCE(p_row->>'asana_project_gid', asana_project_gid),
      asana_section_gid  = COALESCE(p_row->>'asana_section_gid', asana_section_gid),
      asana_section_name = COALESCE(p_row->>'asana_section_name', asana_section_name),
      match_status       = COALESCE(v_ms, match_status),
      historical_snapshot= COALESCE(p_row->'historical_snapshot', historical_snapshot),
      raw_asana_snapshot = COALESCE(p_row->'raw_asana_snapshot', raw_asana_snapshot),
      last_synced_at     = now(),
      sync_run_id        = COALESCE(p_row->>'sync_run_id', sync_run_id),
      updated_at         = now()
    WHERE id = v_id;
    v_action := 'updated';
  ELSE
    INSERT INTO public.processing_records (
      id, record_type, program, title, processing_date, status, number_processed,
      assignee_name, assignee_profile_id,
      source_kind, source_id, asana_gid, asana_project_gid, asana_section_gid,
      asana_section_name, match_status, historical_snapshot, raw_asana_snapshot,
      last_synced_at, sync_run_id, created_by
    ) VALUES (
      v_id, v_type,
      COALESCE(p_row->>'program', 'broiler'),
      COALESCE(p_row->>'title', '(untitled)'),
      (p_row->>'processing_date')::date,
      COALESCE(p_row->>'status', 'planned'),
      (p_row->>'number_processed')::int,
      p_row->>'assignee_name', v_pid,
      NULL, NULL,
      v_gid,
      p_row->>'asana_project_gid',
      p_row->>'asana_section_gid',
      p_row->>'asana_section_name',
      COALESCE(v_ms, 'unmatched'),
      COALESCE(p_row->'historical_snapshot', '{}'::jsonb),
      COALESCE(p_row->'raw_asana_snapshot', '{}'::jsonb),
      now(), p_row->>'sync_run_id', public._processing_import_actor()
    );
    v_action := 'inserted';
  END IF;
  RETURN jsonb_build_object('id', v_id, 'action', v_action, 'asana_gid', v_gid);
END
$fn$;
REVOKE ALL ON FUNCTION public.upsert_processing_from_asana(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_processing_from_asana(jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- End of 165_processing_import_history.sql
-- ============================================================================
