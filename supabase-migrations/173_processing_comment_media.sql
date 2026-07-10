-- ============================================================================
-- 173_processing_comment_media.sql
-- ----------------------------------------------------------------------------
-- Conversation Fidelity: imported Asana conversation media renders as REAL
-- imported comments (original author + timestamp + attached media) while the
-- same stored bytes also index in the record-level Attachments list.
--
-- 1. processing_attachments provenance (nullable; enrichment-only):
--      asana_story_gid       — the originating comment/attachment story
--      original_author_name  — the Asana author who posted the file
--      comment_id            — the imported comment carrying this media
--    (original_created_at already exists from 156.)
--    The asana_attachment_gid UNIQUE idempotency contract is unchanged.
--
-- 2. record_processing_comment_media(p_row) — service_role-only, ATOMIC:
--      • resolves the Processing parent via processing_asana_links;
--      • creates OR reuses the imported comment by asana_comment_gid —
--        file-only posts carry an empty body but a real author/timestamp;
--        reuse NEVER touches body/author/timestamp (a text comment imported
--        earlier by sync_comments is only ENRICHED with its media metadata);
--      • writes the comments.attachments metadata in the shared CommentsSection
--        shape ({bucket, path, name, mime, size_bytes, is_image, captured_at})
--        with bucket pinned to 'processing-attachments';
--      • upserts the processing_attachments row per file (skip-or-enrich by
--        asana_attachment_gid; NEVER a duplicate row on retry);
--      • validated display-only mentions (no notification path exists here);
--      • local/native comments and locally uploaded attachments are untouched
--        (everything keys off Asana gids).
--
-- Error class: PROCESSING_VALIDATION:. NO BEGIN/COMMIT (TEST via exec_sql;
-- PROD via psql --single-transaction). Depends on: 156 (attachments table),
-- 157 (links + imported-comment columns + read-only guards), 165 (mentions
-- validation precedent).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── 1. Attachment provenance columns ─────────────────────────────────────────
ALTER TABLE public.processing_attachments
  ADD COLUMN IF NOT EXISTS asana_story_gid      text,
  ADD COLUMN IF NOT EXISTS original_author_name text,
  ADD COLUMN IF NOT EXISTS comment_id           text REFERENCES public.comments(id) ON DELETE SET NULL;

-- ── 2. Atomic imported comment-media recorder (service_role only) ────────────
CREATE OR REPLACE FUNCTION public.record_processing_comment_media(p_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_story_gid   text := p_row->>'asana_comment_gid';
  v_rec_id      text;
  v_comment_id  text;
  v_existing    record;
  v_mentions    uuid[] := ARRAY[]::uuid[];
  v_m           jsonb;
  v_meta        jsonb;
  v_att_gid     text;
  v_att_id      text;
  v_att_row     record;
  v_metas_json  jsonb := '[]'::jsonb;
  v_comment_action text;
  v_atts_inserted  int := 0;
  v_atts_enriched  int := 0;
  v_is_image    boolean;
BEGIN
  IF v_story_gid IS NULL OR btrim(v_story_gid) = '' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: asana_comment_gid (story gid) required';
  END IF;
  IF jsonb_typeof(COALESCE(p_row->'attachments', 'null'::jsonb)) <> 'array'
     OR jsonb_array_length(p_row->'attachments') = 0 THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: comment media requires at least one attachment';
  END IF;

  SELECT processing_record_id INTO v_rec_id
    FROM public.processing_asana_links
   WHERE asana_gid = p_row->>'parent_asana_gid' AND processing_record_id IS NOT NULL;
  IF v_rec_id IS NULL THEN
    -- Diagnostic payload on purpose: the importer logs this verbatim, so a bad
    -- parent gid is identifiable without a round trip.
    RAISE EXCEPTION 'PROCESSING_VALIDATION: parent record not linked for comment media (parent_asana_gid=%)',
      COALESCE(p_row->>'parent_asana_gid', '<null>');
  END IF;

  -- Display-only mentions (real profiles only; import path never notifies).
  IF jsonb_typeof(COALESCE(p_row->'mentions', 'null'::jsonb)) = 'array' THEN
    FOR v_m IN SELECT e FROM jsonb_array_elements(p_row->'mentions') AS e LOOP
      IF jsonb_typeof(v_m) = 'string'
         AND (v_m #>> '{}') ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'
         AND EXISTS (SELECT 1 FROM public.profiles WHERE id = (v_m #>> '{}')::uuid) THEN
        v_mentions := array_append(v_mentions, (v_m #>> '{}')::uuid);
      END IF;
    END LOOP;
  END IF;

  -- The shared CommentsSection attachment metadata (bucket PINNED server-side —
  -- client metadata can never point elsewhere).
  FOR v_meta IN SELECT e FROM jsonb_array_elements(p_row->'attachments') AS e LOOP
    IF v_meta->>'asana_attachment_gid' IS NULL OR NULLIF(btrim(COALESCE(v_meta->>'storage_path', '')), '') IS NULL THEN
      RAISE EXCEPTION 'PROCESSING_VALIDATION: attachment metadata needs asana_attachment_gid + storage_path';
    END IF;
    v_is_image := COALESCE(v_meta->>'content_type', '') ILIKE 'image/%'
                  OR (v_meta->>'filename') ~* '\.(jpe?g|png|gif|webp|heic)$';
    v_metas_json := v_metas_json || jsonb_build_array(jsonb_build_object(
      'bucket', 'processing-attachments',
      'path', v_meta->>'storage_path',
      'name', COALESCE(v_meta->>'filename', 'attachment'),
      'mime', v_meta->>'content_type',
      'size_bytes', (v_meta->>'size_bytes')::bigint,
      'is_image', v_is_image,
      'captured_at', COALESCE(v_meta->>'original_created_at', p_row->>'created_at')
    ));
  END LOOP;

  -- Comment: create or reuse by the story gid. Reuse ONLY enriches an empty
  -- attachments list — body/author/timestamps/mentions of the stored row are
  -- immutable here (sync_comments/165 own text + mention backfill).
  SELECT id, entity_type, entity_id, source, is_imported, attachments
    INTO v_existing
    FROM public.comments
   WHERE asana_comment_gid = v_story_gid;
  IF FOUND THEN
    IF v_existing.entity_type IS DISTINCT FROM 'processing.record'
       OR v_existing.entity_id IS DISTINCT FROM v_rec_id
       OR v_existing.source IS DISTINCT FROM 'asana'
       OR v_existing.is_imported IS DISTINCT FROM true THEN
      RAISE EXCEPTION
        'PROCESSING_VALIDATION: asana_comment_gid % already belongs to a different comment/record',
        v_story_gid;
    END IF;
    v_comment_id := v_existing.id;
    IF jsonb_array_length(COALESCE(v_existing.attachments, '[]'::jsonb)) = 0 THEN
      UPDATE public.comments SET attachments = v_metas_json WHERE id = v_comment_id;
      v_comment_action := 'enriched';
    ELSE
      v_comment_action := 'reused';
    END IF;
  ELSE
    v_comment_id := COALESCE(p_row->>'id', 'cmt-' || gen_random_uuid()::text);
    INSERT INTO public.comments
      (id, entity_type, entity_id, author_profile_id, body, mentions, attachments,
       source, is_imported, original_author_name, asana_comment_gid, created_at)
    VALUES (
      v_comment_id, 'processing.record', v_rec_id, NULL,
      COALESCE(p_row->>'body', ''), v_mentions, v_metas_json,
      'asana', true, p_row->>'original_author_name', v_story_gid,
      COALESCE((p_row->>'created_at')::timestamptz, now())
    );
    v_comment_action := 'inserted';
  END IF;

  -- Attachment index rows: skip-or-enrich by asana_attachment_gid (idempotent;
  -- an attachment_backfill-created row gains its conversational provenance).
  FOR v_meta IN SELECT e FROM jsonb_array_elements(p_row->'attachments') AS e LOOP
    v_att_gid := v_meta->>'asana_attachment_gid';
    SELECT id, record_id, asana_story_gid, comment_id, original_author_name
      INTO v_att_row
      FROM public.processing_attachments WHERE asana_attachment_gid = v_att_gid;
    IF FOUND THEN
      IF v_att_row.record_id <> v_rec_id
         OR (v_att_row.comment_id IS NOT NULL AND v_att_row.comment_id <> v_comment_id)
         OR (v_att_row.asana_story_gid IS NOT NULL AND v_att_row.asana_story_gid <> v_story_gid) THEN
        RAISE EXCEPTION
          'PROCESSING_VALIDATION: asana_attachment_gid % has conflicting record/comment provenance',
          v_att_gid;
      END IF;
      IF v_att_row.comment_id IS NULL
         OR v_att_row.asana_story_gid IS NULL
         OR v_att_row.original_author_name IS NULL THEN
        UPDATE public.processing_attachments SET
          asana_story_gid      = COALESCE(asana_story_gid, v_story_gid),
          original_author_name = COALESCE(original_author_name, p_row->>'original_author_name'),
          comment_id           = COALESCE(comment_id, v_comment_id)
        WHERE id = v_att_row.id;
        v_atts_enriched := v_atts_enriched + 1;
      END IF;
      CONTINUE;
    END IF;
    v_att_id := 'pat-' || gen_random_uuid()::text;
    INSERT INTO public.processing_attachments
      (id, record_id, filename, content_type, size_bytes, storage_path, asana_attachment_gid,
       source_url, original_created_at, asana_story_gid, original_author_name, comment_id, created_by)
    VALUES (
      v_att_id, v_rec_id, COALESCE(v_meta->>'filename', 'attachment'), v_meta->>'content_type',
      (v_meta->>'size_bytes')::bigint, v_meta->>'storage_path', v_att_gid,
      v_meta->>'source_url', (v_meta->>'original_created_at')::timestamptz,
      v_story_gid, p_row->>'original_author_name', v_comment_id, public._processing_import_actor()
    );
    v_atts_inserted := v_atts_inserted + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'comment_id', v_comment_id,
    'comment_action', v_comment_action,
    'attachments_inserted', v_atts_inserted,
    'attachments_enriched', v_atts_enriched
  );
END
$fn$;
REVOKE ALL ON FUNCTION public.record_processing_comment_media(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_processing_comment_media(jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- End of 173_processing_comment_media.sql
-- ============================================================================
