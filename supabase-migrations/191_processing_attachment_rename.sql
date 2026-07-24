-- ============================================================================
-- 191_processing_attachment_rename.sql
-- ----------------------------------------------------------------------------
-- Operational users may EDIT an attachment's DISPLAY filename. This is a
-- metadata-only rename: storage_path, the Storage object, bytes, provenance
-- (asana_attachment_gid / source_url / original_created_at), size, and content
-- type are all untouched.
--
-- Contract — rename_processing_attachment(p_id, p_filename):
--   • authenticated operational caller only (farm_team / management / admin),
--     enforced server-side through _processing_require_operational(); read-only
--     roles (light / equipment_tech / inactive) and anon are refused. The table
--     stays deny-all with NO direct UPDATE grant — the rename is only reachable
--     through this SECURITY DEFINER RPC.
--   • locks the row FOR UPDATE, then validates: trimmed non-empty, <= 200 chars,
--     no path separators (/ or \), no control characters. The full displayed
--     name INCLUDING extension is editable.
--   • fails closed for a deleted tombstone (deleted_at) or an in-flight delete
--     request (delete_requested_at) — a file being removed can't be renamed.
--   • unchanged name → succeeds as a no-op replay: NO mutation and NO duplicate
--     Activity (idempotent).
--   • on a real change: updates filename, keeps every linked processing comment
--     attachment coherent by rewriting the `name` of the exact
--     bucket+storage_path entry in comments.attachments on the same record, and
--     emits truthful Activity carrying attachment_id + old/new filename.
--
-- Reconciliation survival: the Asana import RPCs never overwrite an existing
-- row's filename (record_processing_attachment returns 'skipped' on a known
-- gid; record_processing_comment_media only COALESCE-enriches provenance), so a
-- rename is durable across later syncs. This migration does NOT redefine either
-- importer, preserving that guarantee.
--
-- Error class: deterministic failures use 'PROCESSING_VALIDATION:'.
-- NO BEGIN/COMMIT (TEST applies via exec_sql; PROD via psql --single-transaction).
-- Depends on: 156 (table + _processing_require_operational), 164
-- (_processing_emit_activity), 185 (delete lifecycle columns). Storage policies,
-- upload rules, deny-all RLS, and admin-only delete are all left unchanged.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.rename_processing_attachment(p_id text, p_filename text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_role text;
  v_row  public.processing_attachments;
  v_new  text;
  v_old  text;
BEGIN
  -- Authenticated operational caller only (raises for anon / read-only roles).
  v_role := public._processing_require_operational();

  -- Validate the new display name.
  v_new := btrim(COALESCE(p_filename, ''));
  IF v_new = '' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: filename cannot be empty';
  END IF;
  IF length(v_new) > 200 THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: filename cannot exceed 200 characters';
  END IF;
  IF v_new ~ '[/\\]' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: filename cannot contain path separators';
  END IF;
  IF v_new ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: filename cannot contain control characters';
  END IF;

  -- Lock the row, then decide on the locked state.
  SELECT * INTO v_row FROM public.processing_attachments WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: attachment not found';
  END IF;
  -- Fail closed for anything mid-deletion.
  IF v_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: attachment is deleted';
  END IF;
  IF v_row.delete_requested_at IS NOT NULL THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: attachment has a pending delete';
  END IF;

  v_old := v_row.filename;

  -- Unchanged name → idempotent no-op (never a duplicate Activity row).
  IF v_new = v_old THEN
    RETURN jsonb_build_object(
      'id', v_row.id, 'status', 'unchanged', 'filename', v_new, 'replayed', true);
  END IF;

  -- Metadata-only rename: storage_path is deliberately NOT in the SET list.
  UPDATE public.processing_attachments SET filename = v_new WHERE id = v_row.id;

  -- Keep linked processing comment attachment metadata coherent: rewrite the
  -- `name` of the exact bucket + storage_path entry in every comment on this
  -- record, preserving element order and all other fields. Only comments that
  -- actually reference this object are touched.
  UPDATE public.comments c
     SET attachments = (
           SELECT jsonb_agg(
                    CASE
                      WHEN COALESCE(e->>'bucket', '') = 'processing-attachments'
                       AND COALESCE(e->>'path', '')   = v_row.storage_path
                      THEN e || jsonb_build_object('name', v_new)
                      ELSE e
                    END
                    ORDER BY ord)
             FROM jsonb_array_elements(COALESCE(c.attachments, '[]'::jsonb))
                  WITH ORDINALITY AS t(e, ord))
   WHERE c.entity_type = 'processing.record'
     AND c.entity_id = v_row.record_id
     AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(COALESCE(c.attachments, '[]'::jsonb)) AS e
            WHERE e->>'bucket' = 'processing-attachments'
              AND e->>'path'   = v_row.storage_path);

  PERFORM public._processing_emit_activity(
    v_row.record_id, 'field.updated',
    'Renamed attachment "' || v_old || '" to "' || v_new || '"',
    jsonb_build_object(
      'action', 'rename_attachment',
      'attachment_id', v_row.id,
      'old_filename', v_old,
      'new_filename', v_new));

  RETURN jsonb_build_object(
    'id', v_row.id, 'status', 'renamed',
    'old_filename', v_old, 'new_filename', v_new, 'replayed', false);
END
$fn$;
REVOKE ALL ON FUNCTION public.rename_processing_attachment(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rename_processing_attachment(text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- End of 191_processing_attachment_rename.sql
-- ============================================================================
