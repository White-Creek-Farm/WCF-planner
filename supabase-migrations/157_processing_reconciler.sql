-- ============================================================================
-- 157_processing_reconciler.sql
-- ----------------------------------------------------------------------------
-- Planner -> Processing reconciler + many-Asana-to-one-Processing link table +
-- Asana-importer re-scope. Locks the final source-of-truth model: Planner is
-- senior whenever a Planner batch/event exists (any year); Asana is senior only
-- for historical rows with no Planner match. Asana never mints planner_batch
-- rows and never overwrites Planner-owned live facts.
--
-- 1. processing_asana_links — authoritative Asana<->Processing map. One row per
--    Asana task (asana_gid UNIQUE); many links may point at one Processing row
--    (pig: N Asana sub-batch rows -> one Planner trip). Carries per-link drift +
--    ack + crosswalk candidates. processing_records.asana_gid stays as a legacy
--    1:1 convenience for asana_historical rows.
-- 2. processing_records: + sub_batch_attribution jsonb; + partial UNIQUE
--    (source_kind, source_id) so the Planner bridge can never duplicate a batch.
-- 3. processing_subtasks: + source ('native'|'asana'), + done_locally_set /
--    done_set_by / done_set_at so a local check-off is Planner-owned and Asana
--    can never revert it.
-- 4. comments (shared layer): + source / is_imported / original_author_name /
--    asana_comment_gid; re-issue list_comments (imported author wins) +
--    delete_comment (imported rows read-only). edit_comment untouched — imported
--    rows already can't be edited (their author_profile_id is NULL).
-- 5. reconcile_planner_to_processing() — atomic, advisory-locked; enumerates all
--    four programs (cattle/sheep tables + app_store jsonb ppp-v4 broiler /
--    ppp-feeders-v1 pig) and idempotently upserts planner_batch rows by
--    (source_kind, source_id). Planner-owned facts only.
-- 6. Re-scoped Asana RPCs: upsert_processing_from_asana refuses planner_batch;
--    subtask/comment/attachment importers resolve parent via the link;
--    set_processing_subtask_done stamps done_locally_set + emits Activity.
-- 7. link_asana_to_processing (service_role), resolve_processing_asana_link +
--    acknowledge_processing_drift (operational crosswalk/ack),
--    list_processing_reconciliation (buckets).
--
-- Error class: deterministic failures use 'PROCESSING_VALIDATION:'.
-- NO BEGIN/COMMIT (TEST applies via exec_sql; PROD via psql --single-transaction).
-- Apply order: TEST first, PROD after lane approval.
-- Depends on: 156 (processing domain), 071 (comments), 058 (activity_events).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── 1. processing_asana_links (authoritative Asana<->Processing map) ─────────
CREATE TABLE IF NOT EXISTS public.processing_asana_links (
  id                     text PRIMARY KEY,
  asana_gid              text NOT NULL UNIQUE,                 -- one link per Asana task; idempotency key
  processing_record_id   text REFERENCES public.processing_records(id) ON DELETE SET NULL,  -- NULL = unmatched/needs_review
  program                text,
  asana_batch_code       text,                                 -- normalized WCF code if derivable
  match_status           text NOT NULL DEFAULT 'needs_review'
                           CHECK (match_status IN ('matched','historical','needs_review','duplicate_blocked','milestone')),
  match_method           text NOT NULL DEFAULT 'none'
                           CHECK (match_method IN ('auto_exact','manual_crosswalk','historical','milestone','none')),
  confidence             text,
  candidate_record_ids   jsonb NOT NULL DEFAULT '[]'::jsonb,    -- crosswalk suggestions
  matched_by             uuid REFERENCES public.profiles(id),
  matched_at             timestamptz,
  raw_asana_snapshot     jsonb NOT NULL DEFAULT '{}'::jsonb,
  drift                  jsonb NOT NULL DEFAULT '{}'::jsonb,    -- this Asana row's date/count/status vs the linked Planner record
  drift_acknowledged_by  uuid REFERENCES public.profiles(id),
  drift_acknowledged_at  timestamptz,
  sync_run_id            text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS processing_asana_links_record_idx
  ON public.processing_asana_links (processing_record_id)
  WHERE processing_record_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS processing_asana_links_review_idx
  ON public.processing_asana_links (created_at DESC)
  WHERE match_status = 'needs_review';

REVOKE ALL ON TABLE public.processing_asana_links FROM PUBLIC, anon, authenticated;
ALTER TABLE public.processing_asana_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS processing_asana_links_deny_all ON public.processing_asana_links;
CREATE POLICY processing_asana_links_deny_all ON public.processing_asana_links FOR ALL USING (false);

-- ── 2. processing_records deltas ─────────────────────────────────────────────
ALTER TABLE public.processing_records
  ADD COLUMN IF NOT EXISTS sub_batch_attribution jsonb NOT NULL DEFAULT '[]'::jsonb;
-- One Processing row per Planner batch/event: the Planner bridge upserts by
-- (source_kind, source_id); the partial unique index makes a duplicate impossible.
CREATE UNIQUE INDEX IF NOT EXISTS processing_records_source_uniq
  ON public.processing_records (source_kind, source_id)
  WHERE source_id IS NOT NULL;

-- ── 3. processing_subtasks deltas (imported vs native + local ownership) ─────
ALTER TABLE public.processing_subtasks
  ADD COLUMN IF NOT EXISTS source           text NOT NULL DEFAULT 'native',
  ADD COLUMN IF NOT EXISTS done_locally_set boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS done_set_by      uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS done_set_at      timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'processing_subtasks_source_check') THEN
    ALTER TABLE public.processing_subtasks
      ADD CONSTRAINT processing_subtasks_source_check CHECK (source IN ('native','asana'));
  END IF;
END $$;

-- ── 4. comments deltas (imported Asana authorship) ───────────────────────────
ALTER TABLE public.comments
  ADD COLUMN IF NOT EXISTS source               text NOT NULL DEFAULT 'native',
  ADD COLUMN IF NOT EXISTS is_imported          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS original_author_name text,
  ADD COLUMN IF NOT EXISTS asana_comment_gid    text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'comments_source_check') THEN
    ALTER TABLE public.comments ADD CONSTRAINT comments_source_check CHECK (source IN ('native','asana'));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS comments_asana_comment_gid_key
  ON public.comments (asana_comment_gid) WHERE asana_comment_gid IS NOT NULL;

-- Re-issue list_comments: imported author wins, then the joined profile, then a
-- literal; return source + is_imported. Everything else (deleted-row redaction,
-- ordering, mentions) preserved verbatim from mig 071.
CREATE OR REPLACE FUNCTION public.list_comments(
  p_entity_type text,
  p_entity_id   text,
  p_limit       int DEFAULT 50
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_role   text;
  v_result jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'list_comments: authenticated caller required';
  END IF;
  v_role := public.profile_role();
  IF v_role IS NULL OR v_role = 'inactive' THEN
    RAISE EXCEPTION 'list_comments: caller role % cannot read', COALESCE(v_role, 'null');
  END IF;
  IF NOT public._activity_can_read(p_entity_type, p_entity_id) THEN
    RAISE EXCEPTION 'list_comments: not permitted for entity_type=%', p_entity_type;
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(r) ORDER BY r.created_at DESC), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT
      c.id,
      c.entity_type,
      c.entity_id,
      c.author_profile_id,
      COALESCE(c.original_author_name, p.full_name, 'Unknown user') AS author_display_name,
      c.source,
      c.is_imported,
      CASE WHEN c.deleted_at IS NOT NULL AND v_role <> 'admin'
           THEN NULL ELSE c.body END AS body,
      CASE WHEN c.deleted_at IS NOT NULL AND v_role <> 'admin'
           THEN ARRAY[]::uuid[] ELSE c.mentions END AS mentions,
      CASE WHEN c.deleted_at IS NOT NULL AND v_role <> 'admin'
           THEN ARRAY[]::text[]
           ELSE (SELECT array_agg(COALESCE(mp.full_name, 'Unknown') ORDER BY m.ord)
                 FROM unnest(c.mentions) WITH ORDINALITY AS m(uid, ord)
                 LEFT JOIN public.profiles mp ON mp.id = m.uid)
      END AS mentioned_profile_names,
      CASE WHEN c.deleted_at IS NOT NULL AND v_role <> 'admin'
           THEN '[]'::jsonb ELSE c.attachments END AS attachments,
      c.edited_at,
      c.deleted_at,
      c.created_at
    FROM public.comments c
    LEFT JOIN public.profiles p ON p.id = c.author_profile_id
    WHERE c.entity_type = p_entity_type
      AND c.entity_id = p_entity_id
    ORDER BY c.created_at DESC
    LIMIT GREATEST(p_limit, 1)
  ) r;

  RETURN v_result;
END
$fn$;
REVOKE ALL ON FUNCTION public.list_comments(text, text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_comments(text, text, int) TO authenticated;

-- Re-issue delete_comment: PRESERVES both mig-112 Cattle Log guards (the
-- clog-* / cattle_log_tag_links mirror guard AND the 'cattle.log' originals
-- guard) verbatim, and ADDS the imported-Asana read-only guard. Dropping either
-- 112 guard would let an admin soft-delete a cattle-log mirror/original outside
-- the Cattle Log RPCs, so all three guards must coexist.
CREATE OR REPLACE FUNCTION public.delete_comment(
  p_comment_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_role   text;
  v_row    record;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'delete_comment: authenticated caller required';
  END IF;

  -- Cattle Log mirror guard (mig 112) — PRESERVED verbatim.
  IF p_comment_id LIKE 'clog-%' OR EXISTS (
    SELECT 1 FROM public.cattle_log_tag_links
     WHERE mirror_comment_id = p_comment_id
  ) THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: cattle log mirrors are managed by the Cattle Log RPCs';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role = 'inactive' THEN
    RAISE EXCEPTION 'delete_comment: caller role % cannot delete', COALESCE(v_role, 'null');
  END IF;

  SELECT id, entity_type, entity_id, author_profile_id, deleted_at, source
    INTO v_row
    FROM public.comments
    WHERE id = p_comment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'delete_comment: comment % not found', p_comment_id;
  END IF;
  IF v_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'delete_comment: comment % already deleted', p_comment_id;
  END IF;
  -- Cattle Log originals guard (mig 112) — PRESERVED verbatim. Deletes of
  -- 'cl-…' log entries go through delete_cattle_log_entry (management/admin
  -- only, which also clears mirrors); the id-based mirror guard above does NOT
  -- cover originals.
  IF v_row.entity_type = 'cattle.log' THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: cattle log entries are managed by the Cattle Log RPCs';
  END IF;
  -- Imported (Asana-sourced) comments are read-only (mig 157).
  IF v_row.source <> 'native' THEN
    RAISE EXCEPTION 'delete_comment: imported (Asana-sourced) comments are read-only';
  END IF;

  IF NOT public._activity_can_write(v_row.entity_type, v_row.entity_id) THEN
    RAISE EXCEPTION 'delete_comment: not permitted for entity';
  END IF;

  IF v_row.author_profile_id IS DISTINCT FROM v_caller AND v_role <> 'admin' THEN
    RAISE EXCEPTION 'delete_comment: only author or admin may delete';
  END IF;

  UPDATE public.comments
    SET deleted_at = now(),
        deleted_by = v_caller
    WHERE id = p_comment_id;

  RETURN jsonb_build_object('ok', true, 'comment_id', p_comment_id);
END
$fn$;
REVOKE ALL ON FUNCTION public.delete_comment(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_comment(text) TO authenticated;

-- Service-role importer for Asana comments: resolves the parent Processing
-- record via the LINK (so N pig sub-batch tasks attach to one trip), preserves
-- the original author name + timestamp, idempotent on asana_comment_gid.
CREATE OR REPLACE FUNCTION public.record_processing_comment(p_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_gid text := p_row->>'asana_comment_gid'; v_rec_id text; v_id text;
BEGIN
  SELECT processing_record_id INTO v_rec_id
    FROM public.processing_asana_links
   WHERE asana_gid = p_row->>'parent_asana_gid' AND processing_record_id IS NOT NULL;
  IF v_rec_id IS NULL THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: parent record not linked for comment';
  END IF;
  IF v_gid IS NOT NULL AND EXISTS (SELECT 1 FROM public.comments WHERE asana_comment_gid = v_gid) THEN
    RETURN jsonb_build_object('action', 'skipped', 'reason', 'already imported');
  END IF;
  v_id := COALESCE(p_row->>'id', 'cmt-' || gen_random_uuid()::text);
  INSERT INTO public.comments
    (id, entity_type, entity_id, author_profile_id, body, mentions, attachments,
     source, is_imported, original_author_name, asana_comment_gid, created_at)
  VALUES (
    v_id, 'processing.record', v_rec_id, NULL,
    COALESCE(p_row->>'body', ''), ARRAY[]::uuid[], '[]'::jsonb,
    'asana', true, p_row->>'original_author_name', v_gid,
    COALESCE((p_row->>'created_at')::timestamptz, now())
  );
  RETURN jsonb_build_object('id', v_id, 'action', 'inserted');
END
$fn$;
REVOKE ALL ON FUNCTION public.record_processing_comment(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_processing_comment(jsonb) TO service_role;

-- ── 5. Re-scope: Asana pass may never mint a planner_batch row ───────────────
-- Only the Planner bridge creates planner_batch rows. upsert_processing_from_asana
-- now creates asana_historical / import_exception / milestone rows only.
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
BEGIN
  IF v_gid IS NULL OR btrim(v_gid) = '' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: asana_gid required for import';
  END IF;
  -- Belt-and-suspenders: the Asana path can never create a planner_batch. Those
  -- belong exclusively to reconcile_planner_to_processing().
  IF v_type = 'planner_batch' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: Asana import may not create planner_batch records';
  END IF;
  -- Coerce the detailed Asana bucket to the record-level match_status domain
  -- (156 CHECK allows only native|matched|review|unmatched). The DETAILED
  -- bucket (historical|milestone|needs_review|import_exception…) is preserved on
  -- the processing_asana_links row, never squeezed onto the record. NULL leaves
  -- the existing value untouched on update / defaults to 'unmatched' on insert.
  v_ms := CASE lower(COALESCE(p_row->>'match_status', ''))
            WHEN 'native'       THEN 'native'
            WHEN 'matched'      THEN 'matched'
            WHEN 'review'       THEN 'review'
            WHEN 'needs_review' THEN 'review'
            WHEN ''             THEN NULL
            ELSE 'unmatched'   -- historical | milestone | import_exception | duplicate_blocked | unmatched
          END;
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
      NULL, NULL,                       -- Asana-only rows carry no Planner source link
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

-- Subtask importer: resolve parent via the LINK; mark source='asana'; never
-- revert a locally-set done state.
CREATE OR REPLACE FUNCTION public.upsert_processing_subtask_from_asana(p_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_gid    text := p_row->>'asana_gid';
  v_rec_id text;
  v_id     text;
  v_exists boolean;
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
  SELECT id INTO v_id FROM public.processing_subtasks WHERE asana_gid = v_gid;
  v_exists := FOUND;
  IF v_exists THEN
    UPDATE public.processing_subtasks SET
      record_id    = v_rec_id,
      label        = COALESCE(p_row->>'label', label),
      assignee     = COALESCE(p_row->>'assignee', assignee),
      -- Asana can only set done while the item has NOT been locally toggled.
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
    (id, record_id, label, assignee, done, completed_at, asana_gid, due_on, start_on, sort_order, source, created_by)
  VALUES (
    v_id, v_rec_id, COALESCE(p_row->>'label', '(untitled)'), p_row->>'assignee',
    COALESCE((p_row->>'done')::boolean, false), (p_row->>'completed_at')::timestamptz, v_gid,
    (p_row->>'due_on')::date, (p_row->>'start_on')::date,
    COALESCE((p_row->>'sort_order')::int, 0), 'asana', public._processing_import_actor()
  );
  RETURN jsonb_build_object('id', v_id, 'action', 'inserted');
END
$fn$;
REVOKE ALL ON FUNCTION public.upsert_processing_subtask_from_asana(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_processing_subtask_from_asana(jsonb) TO service_role;

-- Attachment importer: resolve parent via the LINK.
CREATE OR REPLACE FUNCTION public.record_processing_attachment(p_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_gid text := p_row->>'asana_attachment_gid'; v_rec_id text; v_id text;
BEGIN
  SELECT processing_record_id INTO v_rec_id
    FROM public.processing_asana_links
   WHERE asana_gid = p_row->>'parent_asana_gid' AND processing_record_id IS NOT NULL;
  IF v_rec_id IS NULL THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: parent record not linked for attachment';
  END IF;
  IF v_gid IS NOT NULL AND EXISTS (SELECT 1 FROM public.processing_attachments WHERE asana_attachment_gid = v_gid) THEN
    RETURN jsonb_build_object('action', 'skipped', 'reason', 'already imported');
  END IF;
  v_id := COALESCE(p_row->>'id', 'pat-' || gen_random_uuid()::text);
  INSERT INTO public.processing_attachments
    (id, record_id, filename, content_type, size_bytes, storage_path, asana_attachment_gid,
     source_url, original_created_at, created_by)
  VALUES (
    v_id, v_rec_id, COALESCE(p_row->>'filename', 'attachment'), p_row->>'content_type',
    (p_row->>'size_bytes')::bigint, p_row->>'storage_path', v_gid, p_row->>'source_url',
    (p_row->>'original_created_at')::timestamptz, public._processing_import_actor()
  );
  RETURN jsonb_build_object('id', v_id, 'action', 'inserted');
END
$fn$;
REVOKE ALL ON FUNCTION public.record_processing_attachment(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_processing_attachment(jsonb) TO service_role;

-- Local subtask check-off: Planner-owns it from now on + emit Activity naming
-- the operator (answer 10). Toggling never auto-completes the parent record.
CREATE OR REPLACE FUNCTION public.set_processing_subtask_done(p_id text, p_done boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_caller uuid := auth.uid(); v_sub record; v_ae text;
BEGIN
  PERFORM public._processing_require_operational();
  SELECT id, record_id, label INTO v_sub FROM public.processing_subtasks WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: subtask not found';
  END IF;
  UPDATE public.processing_subtasks SET
    done = COALESCE(p_done, false),
    completed_at = CASE WHEN COALESCE(p_done, false) THEN now() ELSE NULL END,
    done_locally_set = true,
    done_set_by = v_caller,
    done_set_at = now(),
    updated_at = now()
  WHERE id = p_id;
  -- Best-effort Activity on the processing.record (never blocks the toggle).
  BEGIN
    v_ae := 'ae-' || gen_random_uuid()::text;
    INSERT INTO public.activity_events (id, entity_type, entity_id, actor_profile_id, event_type, body, payload)
    VALUES (v_ae, 'processing.record', v_sub.record_id, v_caller, 'field.updated',
            CASE WHEN COALESCE(p_done, false) THEN 'Checked subtask: ' ELSE 'Unchecked subtask: ' END || COALESCE(v_sub.label, ''),
            jsonb_build_object('record', 'processing.subtask', 'subtask_id', p_id,
                               'done', COALESCE(p_done, false), 'action', 'toggle_subtask'));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN jsonb_build_object('id', p_id, 'ok', true, 'done', COALESCE(p_done, false));
END
$fn$;
REVOKE ALL ON FUNCTION public.set_processing_subtask_done(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_processing_subtask_done(text, boolean) TO authenticated;

-- ── 6. link_asana_to_processing (service_role) ───────────────────────────────
-- Upserts a link (asana_gid unique). Seeds processor/customer onto the record
-- ONLY the first time that record gains a link (first attach) and only if blank
-- -> never overwrites a Planner/Processing value, never re-seeds after a clear.
CREATE OR REPLACE FUNCTION public.link_asana_to_processing(p_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_gid    text := p_row->>'asana_gid';
  v_rec_id text := p_row->>'processing_record_id';   -- proposed record; NULL for needs_review
  v_id     text;
  v_first  boolean := false;
  v_existing_method text;
  v_existing_rec    text;
  v_manual boolean := false;
  v_keep_rec boolean := false;
  v_eff_rec text;   -- the record the link ACTUALLY ends up on (after keep/manual rules)
BEGIN
  IF v_gid IS NULL OR btrim(v_gid) = '' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: asana_gid required for link';
  END IF;

  -- Read the existing link (if any) FIRST so the keep/manual rules decide the
  -- effective record BEFORE we compute first-attach or seed anything.
  SELECT id, match_method, processing_record_id
    INTO v_id, v_existing_method, v_existing_rec
    FROM public.processing_asana_links WHERE asana_gid = v_gid;

  -- Never orphan an established resolution (Codex blocker 3):
  --   (a) Durable manual crosswalk — once a human resolves this link
  --       (match_method='manual_crosswalk'), NO automated sync may clear or
  --       repoint it, not even a non-null auto-match to a different record.
  --       Only resolve_processing_asana_link (explicit human action) changes it.
  --   (b) A non-null auto link is preserved against a NULL (ambiguous/unmatched)
  --       re-sync, so imported comments/subtasks attached via this link are never
  --       orphaned; the incoming candidates/drift still record, and the prior
  --       matched status is kept (not silently downgraded while a record is
  --       attached). A fresh non-null auto-match may still repoint a non-manual link.
  IF v_id IS NOT NULL THEN
    v_manual := (v_existing_method = 'manual_crosswalk');
    v_keep_rec := v_manual OR (v_rec_id IS NULL AND v_existing_rec IS NOT NULL);
  END IF;
  -- The EFFECTIVE record: a kept link stays on its existing record even when the
  -- sync proposed a different one. Seeds + first-attach + the return value all
  -- follow the effective record, never the (possibly rejected) proposed record.
  v_eff_rec := CASE WHEN v_keep_rec THEN v_existing_rec ELSE v_rec_id END;

  -- First attach = the EFFECTIVE record gains its first link now: it isn't
  -- already linked by another task, and this link wasn't already on it (so a
  -- kept manual link to A never re-seeds A, and a rejected proposed B is never
  -- seeded). Informational fields (drift, candidates, snapshot, code, program,
  -- sync_run_id) always refresh.
  IF v_eff_rec IS NOT NULL
     AND v_existing_rec IS DISTINCT FROM v_eff_rec
     AND NOT EXISTS (SELECT 1 FROM public.processing_asana_links
                      WHERE processing_record_id = v_eff_rec AND asana_gid <> v_gid) THEN
    v_first := true;
  END IF;

  IF v_id IS NOT NULL THEN
    UPDATE public.processing_asana_links SET
      processing_record_id = v_eff_rec,
      program              = COALESCE(p_row->>'program', program),
      asana_batch_code     = COALESCE(p_row->>'asana_batch_code', asana_batch_code),
      match_status         = CASE WHEN v_manual THEN 'matched'
                                  WHEN v_keep_rec THEN match_status
                                  ELSE COALESCE(p_row->>'match_status', match_status) END,
      match_method         = CASE WHEN v_manual THEN 'manual_crosswalk'
                                  WHEN v_keep_rec THEN match_method
                                  ELSE COALESCE(p_row->>'match_method', match_method) END,
      confidence           = COALESCE(p_row->>'confidence', confidence),
      candidate_record_ids = COALESCE(p_row->'candidate_record_ids', candidate_record_ids),
      raw_asana_snapshot   = COALESCE(p_row->'raw_asana_snapshot', raw_asana_snapshot),
      drift                = COALESCE(p_row->'drift', drift),
      sync_run_id          = COALESCE(p_row->>'sync_run_id', sync_run_id),
      updated_at           = now()
    WHERE id = v_id;
  ELSE
    v_id := 'pal-' || gen_random_uuid()::text;
    INSERT INTO public.processing_asana_links
      (id, asana_gid, processing_record_id, program, asana_batch_code, match_status, match_method,
       confidence, candidate_record_ids, raw_asana_snapshot, drift, sync_run_id)
    VALUES (
      v_id, v_gid, v_eff_rec, p_row->>'program', p_row->>'asana_batch_code',
      COALESCE(p_row->>'match_status', 'needs_review'), COALESCE(p_row->>'match_method', 'none'),
      p_row->>'confidence', COALESCE(p_row->'candidate_record_ids', '[]'::jsonb),
      COALESCE(p_row->'raw_asana_snapshot', '{}'::jsonb), COALESCE(p_row->'drift', '{}'::jsonb),
      p_row->>'sync_run_id'
    );
  END IF;

  -- First-attach seed of the EFFECTIVE record only (never overwrite, never re-seed).
  IF v_first THEN
    UPDATE public.processing_records SET
      processor = CASE WHEN NULLIF(btrim(COALESCE(processor, '')), '') IS NULL
                       THEN NULLIF(btrim(COALESCE(p_row->>'seed_processor', '')), '') ELSE processor END,
      customer  = CASE WHEN jsonb_array_length(COALESCE(customer, '[]'::jsonb)) = 0
                            AND p_row ? 'seed_customer' THEN p_row->'seed_customer' ELSE customer END,
      updated_at = now()
    WHERE id = v_eff_rec;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'asana_gid', v_gid, 'record_id', v_eff_rec, 'first_attach', v_first);
END
$fn$;
REVOKE ALL ON FUNCTION public.link_asana_to_processing(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.link_asana_to_processing(jsonb) TO service_role;

-- ── 7. upsert_processing_from_planner (service_role) ─────────────────────────
-- Idempotent upsert of a planner_batch row by (source_kind, source_id). Writes
-- Planner-owned facts only; never touches processor/customer/completed_at.
CREATE OR REPLACE FUNCTION public.upsert_processing_from_planner(p_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_kind text := p_row->>'source_kind';
  v_sid  text := p_row->>'source_id';
  v_id   text;
BEGIN
  IF v_kind IS NULL OR v_sid IS NULL OR btrim(v_sid) = '' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: source_kind + source_id required';
  END IF;
  SELECT id INTO v_id FROM public.processing_records WHERE source_kind = v_kind AND source_id = v_sid;
  IF FOUND THEN
    UPDATE public.processing_records SET
      record_type           = 'planner_batch',
      program               = COALESCE(p_row->>'program', program),
      title                 = COALESCE(p_row->>'title', title),
      processing_date       = COALESCE((p_row->>'processing_date')::date, processing_date),
      status                = COALESCE(p_row->>'status', status),
      number_processed      = COALESCE((p_row->>'number_processed')::int, number_processed),
      sub_batch_attribution = COALESCE(p_row->'sub_batch_attribution', sub_batch_attribution),
      match_status          = CASE WHEN match_status = 'native' THEN 'native' ELSE match_status END,
      -- Planner source is eligible again -> un-hide it (preserving all
      -- Processing-owned local data + links + comments) and stamp this run so
      -- the reconcile sweep does NOT re-archive it.
      archived              = false,
      sync_run_id           = COALESCE(p_row->>'sync_run_id', sync_run_id),
      last_synced_at        = now(),
      updated_at            = now()
    WHERE id = v_id;
    RETURN jsonb_build_object('id', v_id, 'action', 'updated');
  END IF;
  v_id := 'prc-' || gen_random_uuid()::text;
  INSERT INTO public.processing_records
    (id, record_type, program, title, processing_date, status, number_processed,
     source_kind, source_id, sub_batch_attribution, match_status, sync_run_id, last_synced_at, created_by)
  VALUES (
    v_id, 'planner_batch', COALESCE(p_row->>'program', 'broiler'),
    COALESCE(p_row->>'title', v_sid), (p_row->>'processing_date')::date,
    COALESCE(p_row->>'status', 'planned'), (p_row->>'number_processed')::int,
    v_kind, v_sid, COALESCE(p_row->'sub_batch_attribution', '[]'::jsonb),
    'native', p_row->>'sync_run_id', now(), public._processing_import_actor()
  );
  RETURN jsonb_build_object('id', v_id, 'action', 'inserted');
END
$fn$;
REVOKE ALL ON FUNCTION public.upsert_processing_from_planner(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_processing_from_planner(jsonb) TO service_role;

-- ── 8. reconcile_planner_to_processing() (atomic, advisory-locked) ───────────
-- Enumerates all four programs and idempotently upserts planner_batch rows.
-- Broiler (ppp-v4) row only when a processingDate is set; pig row per ACTUAL
-- trip (source_id group.id:trip.id); cattle/sheep one row per processing batch
-- (processing_date = COALESCE(actual, planned)). A per-run sync_run_id stamps
-- every upsert; any planner_batch row NOT re-stamped this run is retired
-- (archived) because its Planner source is gone.
CREATE OR REPLACE FUNCTION public.reconcile_planner_to_processing()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_role text;
  v_run  text := 'reconcile-' || gen_random_uuid()::text;
  v_cattle int := 0; v_sheep int := 0; v_broiler int := 0; v_pig int := 0;
  v_retired int := 0;
  v_c record; v_s record; v_b jsonb; v_g jsonb; v_t jsonb;
BEGIN
  -- service_role (no auth.uid()) OR management/admin may run it.
  IF auth.uid() IS NOT NULL THEN
    v_role := public.profile_role();
    IF v_role IS NULL OR v_role NOT IN ('management','admin') THEN
      RAISE EXCEPTION 'PROCESSING_VALIDATION: caller role % cannot reconcile', COALESCE(v_role,'null');
    END IF;
  END IF;
  -- Serialize reconciles so a concurrent run can't race duplicate rows.
  PERFORM pg_advisory_xact_lock(hashtext('processing_reconcile'));

  -- Cattle: one row per processing batch.
  FOR v_c IN SELECT id, name, status, actual_process_date, planned_process_date, cows_detail
               FROM public.cattle_processing_batches LOOP
    PERFORM public.upsert_processing_from_planner(jsonb_build_object(
      'source_kind','cattle','source_id', v_c.id, 'program','cattle',
      'title', COALESCE(v_c.name, v_c.id),
      'processing_date', COALESCE(v_c.actual_process_date, v_c.planned_process_date),
      'status', v_c.status, 'sync_run_id', v_run,
      'number_processed', jsonb_array_length(COALESCE(v_c.cows_detail, '[]'::jsonb))));
    v_cattle := v_cattle + 1;
  END LOOP;

  -- Sheep: one row per processing batch.
  FOR v_s IN SELECT id, name, status, actual_process_date, planned_process_date, sheep_detail
               FROM public.sheep_processing_batches LOOP
    PERFORM public.upsert_processing_from_planner(jsonb_build_object(
      'source_kind','sheep','source_id', v_s.id, 'program','sheep',
      'title', COALESCE(v_s.name, v_s.id),
      'processing_date', COALESCE(v_s.actual_process_date, v_s.planned_process_date),
      'status', v_s.status, 'sync_run_id', v_run,
      'number_processed', jsonb_array_length(COALESCE(v_s.sheep_detail, '[]'::jsonb))));
    v_sheep := v_sheep + 1;
  END LOOP;

  -- Broiler (app_store ppp-v4): row only when a processingDate is set.
  FOR v_b IN SELECT value FROM jsonb_array_elements(
               COALESCE((SELECT data::jsonb FROM public.app_store WHERE key = 'ppp-v4'), '[]'::jsonb)) AS t(value) LOOP
    CONTINUE WHEN COALESCE(NULLIF(btrim(COALESCE(v_b->>'processingDate', v_b->>'processing_date', '')), ''), NULL) IS NULL;
    CONTINUE WHEN COALESCE(btrim(COALESCE(v_b->>'name','')), '') = '';
    PERFORM public.upsert_processing_from_planner(jsonb_build_object(
      'source_kind','broiler','source_id', v_b->>'name', 'program','broiler',
      'title', v_b->>'name',
      'processing_date', COALESCE(v_b->>'processingDate', v_b->>'processing_date'),
      'status', COALESCE(v_b->>'status','planned'), 'sync_run_id', v_run,
      'number_processed', COALESCE(v_b->>'totalToProcessor', v_b->>'total_to_processor')));
    v_broiler := v_broiler + 1;
  END LOOP;

  -- Pig (app_store ppp-feeders-v1): one row per ACTUAL processing trip.
  FOR v_g IN SELECT value FROM jsonb_array_elements(
               COALESCE((SELECT data::jsonb FROM public.app_store WHERE key = 'ppp-feeders-v1'), '[]'::jsonb)) AS t(value) LOOP
    FOR v_t IN SELECT value FROM jsonb_array_elements(COALESCE(v_g->'processingTrips', '[]'::jsonb)) AS t(value) LOOP
      CONTINUE WHEN COALESCE(btrim(COALESCE(v_t->>'id','')), '') = '';
      PERFORM public.upsert_processing_from_planner(jsonb_build_object(
        'source_kind','pig',
        'source_id', (v_g->>'id') || ':' || (v_t->>'id'),
        'program','pig',
        'title', COALESCE(v_g->>'batchName', v_g->>'id') || ' — ' || COALESCE(v_t->>'date',''),
        'processing_date', v_t->>'date',
        'status', 'processed', 'sync_run_id', v_run,
        'number_processed', v_t->>'pigCount',
        'sub_batch_attribution', COALESCE(v_t->'subAttributions', '[]'::jsonb)));
      v_pig := v_pig + 1;
    END LOOP;
  END LOOP;

  -- Retire stale Planner-derived rows: any planner_batch row NOT re-stamped by
  -- this run means its Planner source is gone (a cleared broiler processingDate,
  -- a removed pig trip, a deleted cattle/sheep batch). Archive it — hidden from
  -- active views but fully preserved (local data + links + comments intact) so a
  -- later re-upsert un-archives it if the Planner source becomes eligible again.
  -- Only planner_batch rows are swept; asana_historical/import_exception/native/
  -- milestone rows are never touched here.
  UPDATE public.processing_records
     SET archived = true, updated_at = now()
   WHERE record_type = 'planner_batch'
     AND archived = false
     AND sync_run_id IS DISTINCT FROM v_run;
  GET DIAGNOSTICS v_retired = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'cattle', v_cattle, 'sheep', v_sheep,
                            'broiler', v_broiler, 'pig', v_pig, 'retired', v_retired);
END
$fn$;
REVOKE ALL ON FUNCTION public.reconcile_planner_to_processing() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reconcile_planner_to_processing() TO authenticated, service_role;

-- ── 9. Manual crosswalk + drift ack + reconciliation report ─────────────────
CREATE OR REPLACE FUNCTION public.resolve_processing_asana_link(p_asana_gid text, p_record_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_caller uuid := auth.uid(); v_first boolean := false;
BEGIN
  PERFORM public._processing_require_operational();
  IF NOT EXISTS (SELECT 1 FROM public.processing_asana_links WHERE asana_gid = p_asana_gid) THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: link not found';
  END IF;
  IF p_record_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.processing_records WHERE id = p_record_id) THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: target record not found';
  END IF;
  UPDATE public.processing_asana_links SET
    processing_record_id = p_record_id,
    match_status = CASE WHEN p_record_id IS NULL THEN 'needs_review' ELSE 'matched' END,
    match_method = CASE WHEN p_record_id IS NULL THEN 'none' ELSE 'manual_crosswalk' END,
    matched_by = v_caller, matched_at = now(), updated_at = now()
  WHERE asana_gid = p_asana_gid;
  RETURN jsonb_build_object('ok', true, 'asana_gid', p_asana_gid, 'record_id', p_record_id);
END
$fn$;
REVOKE ALL ON FUNCTION public.resolve_processing_asana_link(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_processing_asana_link(text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.acknowledge_processing_drift(p_asana_gid text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_caller uuid := auth.uid();
BEGIN
  PERFORM public._processing_require_operational();
  UPDATE public.processing_asana_links SET
    drift_acknowledged_by = v_caller, drift_acknowledged_at = now(), updated_at = now()
  WHERE asana_gid = p_asana_gid;
  RETURN jsonb_build_object('ok', true, 'asana_gid', p_asana_gid);
END
$fn$;
REVOKE ALL ON FUNCTION public.acknowledge_processing_drift(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.acknowledge_processing_drift(text) TO authenticated;

-- Reconciliation report: bucketed link + planner-only view for the admin surface.
CREATE OR REPLACE FUNCTION public.list_processing_reconciliation()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE
AS $fn$
DECLARE v_links jsonb; v_planner_only int;
BEGIN
  PERFORM public._processing_require_operational();
  SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.created_at DESC), '[]'::jsonb)
    INTO v_links FROM public.processing_asana_links l;
  -- Exclude retired (archived) planner rows so they don't inflate the admin count.
  SELECT count(*) INTO v_planner_only
    FROM public.processing_records r
   WHERE r.record_type = 'planner_batch'
     AND r.archived = false
     AND NOT EXISTS (SELECT 1 FROM public.processing_asana_links l WHERE l.processing_record_id = r.id);
  RETURN jsonb_build_object(
    'links', v_links,
    'planner_only_count', v_planner_only,
    'needs_review_count', (SELECT count(*) FROM public.processing_asana_links WHERE match_status = 'needs_review'),
    'matched_count',      (SELECT count(*) FROM public.processing_asana_links WHERE match_status = 'matched'),
    'historical_count',   (SELECT count(*) FROM public.processing_asana_links WHERE match_status = 'historical'),
    'drift_count',        (SELECT count(*) FROM public.processing_asana_links
                            WHERE drift <> '{}'::jsonb AND drift_acknowledged_at IS NULL)
  );
END
$fn$;
REVOKE ALL ON FUNCTION public.list_processing_reconciliation() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_processing_reconciliation() TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- End of 157_processing_reconciler.sql
-- ============================================================================
