-- ============================================================================
-- 166_processing_attachments_upload.sql
-- ----------------------------------------------------------------------------
-- Native in-app attachment upload for Processing records ("Add files" in the
-- record drawer), on top of the mig-163 private 'processing-attachments' bucket.
--
-- Provenance model (two disjoint path namespaces in ONE private bucket):
--   • Asana-imported bytes  → '<parent_asana_gid>/<attachment_gid>-<filename>'
--     written ONLY by the Edge importer under service_role (BYPASSRLS). No
--     authenticated policy grants these paths.
--   • Native uploads        → 'native/<record_id>/<uuid>-<filename>' written by
--     operational authenticated users through the INSERT policy below, then
--     registered via add_processing_attachment (caller provenance, no Asana gid).
--
-- Boundary:
--   • INSERT policy: operational roles only (farm_team/management/admin via
--     public.profile_role(), the same boundary as the mig-163 SELECT policy),
--     bucket-scoped, and ONLY under the 'native/' prefix — an authenticated
--     user can never write into (or shadow) the importer's Asana namespace.
--   • NO UPDATE and NO DELETE policies: the bucket stays append-only for
--     authenticated users. Destructive removal is intentionally NOT shipped
--     (its ownership/audit/recovery contract needs its own approved design).
--   • add_processing_attachment RPC (operational): validates the record, the
--     path shape (must match the caller's declared record + native namespace),
--     filename and size, inserts the metadata row with created_by = caller and
--     NO asana_attachment_gid, and emits best-effort Activity.
--
-- Reads stay signed-URL only via the mig-163 operational SELECT policy.
-- Error class: deterministic failures use 'PROCESSING_VALIDATION:'.
-- NO BEGIN/COMMIT (TEST applies via exec_sql; PROD via psql --single-transaction).
-- Depends on: 156 (tables), 163 (bucket + SELECT policy), 164 (_processing_emit_activity).
-- ============================================================================

-- ── 1. Operational INSERT policy, native/ namespace only ─────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'processing_attachments_operational_insert'
  ) THEN
    CREATE POLICY processing_attachments_operational_insert ON storage.objects
      FOR INSERT TO authenticated
      WITH CHECK (
        bucket_id = 'processing-attachments'
        AND public.profile_role() IN ('farm_team', 'management', 'admin')
        AND name LIKE 'native/%'
      );
  END IF;
END $$;

-- ── 2. Register a native upload (metadata row + Activity) ────────────────────
CREATE OR REPLACE FUNCTION public.add_processing_attachment(p_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_caller   uuid := auth.uid();
  v_id       text := p_row->>'id';
  v_rec_id   text := p_row->>'record_id';
  v_filename text := NULLIF(btrim(COALESCE(p_row->>'filename', '')), '');
  v_path     text := p_row->>'storage_path';
  v_size     bigint := (p_row->>'size_bytes')::bigint;
BEGIN
  PERFORM public._processing_require_operational();
  IF v_id IS NULL OR v_id !~ '^[A-Za-z0-9-]+$' OR length(v_id) > 100 THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: invalid attachment id';
  END IF;
  IF EXISTS (SELECT 1 FROM public.processing_attachments WHERE id = v_id) THEN
    RETURN jsonb_build_object('id', v_id, 'replayed', true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.processing_records WHERE id = v_rec_id) THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: record not found';
  END IF;
  IF v_filename IS NULL OR length(v_filename) > 200 THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: a filename (max 200 chars) is required';
  END IF;
  -- The storage path must sit in THIS record's native namespace — the metadata
  -- row can never point at another record's file or the importer's Asana paths.
  IF v_path IS NULL OR v_path NOT LIKE ('native/' || v_rec_id || '/%') OR length(v_path) > 400 THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: storage path must be under native/<record id>/';
  END IF;
  IF v_size IS NOT NULL AND (v_size < 0 OR v_size > 52428800) THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: attachment too large (max 50 MB)';
  END IF;

  INSERT INTO public.processing_attachments
    (id, record_id, filename, content_type, size_bytes, storage_path, created_by)
  VALUES
    (v_id, v_rec_id, v_filename, NULLIF(btrim(COALESCE(p_row->>'content_type', '')), ''),
     v_size, v_path, v_caller);

  PERFORM public._processing_emit_activity(
    v_rec_id, 'field.updated', 'Added attachment: ' || v_filename,
    jsonb_build_object('action', 'add_attachment', 'attachment_id', v_id));

  RETURN jsonb_build_object('id', v_id, 'replayed', false);
END
$fn$;
REVOKE ALL ON FUNCTION public.add_processing_attachment(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_processing_attachment(jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- End of 166_processing_attachments_upload.sql
-- ============================================================================
