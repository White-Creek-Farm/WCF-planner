-- ============================================================================
-- 161_processing_archive_record.sql
-- ----------------------------------------------------------------------------
-- Soft delete/restore for Processing records. Preferred over
-- hard_delete_processing_record (mig 156): the record AND its Asana link
-- provenance survive (archived=true just hides it from the active calendar/queues;
-- processing_asana_links are untouched). Refuses planner_batch — those are
-- Planner-owned and managed by reconcile_planner_to_processing; unschedule them
-- in the Planner instead.
--
-- No schema/table/RLS/CHECK change; reuses the existing archived flag + the
-- operational-role gate. Depends on: 156 (processing_records +
-- _processing_require_operational).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.archive_processing_record(p_id text, p_archived boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_type text;
BEGIN
  PERFORM public._processing_require_operational();
  SELECT record_type INTO v_type FROM public.processing_records WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('id', p_id, 'ok', true, 'already_gone', true);
  END IF;
  -- Planner-owned rows are reconcile-managed; archiving here would just be undone
  -- on the next reconcile, so refuse it (matches hard_delete_processing_record).
  IF v_type = 'planner_batch' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: planner-owned records cannot be archived here';
  END IF;
  UPDATE public.processing_records
     SET archived = COALESCE(p_archived, true), updated_at = now()
   WHERE id = p_id;
  RETURN jsonb_build_object('id', p_id, 'ok', true, 'archived', COALESCE(p_archived, true));
END
$fn$;
REVOKE ALL ON FUNCTION public.archive_processing_record(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.archive_processing_record(text, boolean) TO authenticated;

NOTIFY pgrst, 'reload schema';
