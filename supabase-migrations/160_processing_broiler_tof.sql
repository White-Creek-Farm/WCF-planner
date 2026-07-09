-- ============================================================================
-- 160_processing_broiler_tof.sql
-- ----------------------------------------------------------------------------
-- Server-derive broiler Time-on-Farm so the Processing table + drawer stop
-- showing dashes for broiler planner rows. Read-only derivation only — NO
-- schema/table/RLS/CHECK/grant change, same return shape plus one added key.
--
-- Broiler TOF = whole days between the batch's processingDate and hatchDate,
-- read from app_store 'ppp-v4' keyed by source_id == batch name (the same source
-- + formula src/lib/processingSourceLink.js uses; birds arrive as day-old chicks
-- so TOF is their age). Both RPCs now return time_on_farm_days (int) on broiler
-- planner_batch rows and NULL elsewhere; the client formats it as weeks/days and
-- falls back to the record snapshot for imported/historical rows.
--
-- Reissues: list_processing_records (adds the value per row) and
-- get_processing_record (adds it to the record object). Everything else — the
-- operational gate, subtask counts, drawer nesting, grants — is preserved.
-- Depends on: 156 (both RPCs + processing tables), app_store 'ppp-v4'.
-- ============================================================================

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
  -- Broiler TOF map: one whole-day gap per batch name from app_store ppp-v4.
  -- DISTINCT ON keeps a single row per name; the regex guard makes left(...)::date
  -- safe against a full-timestamp value.
  WITH broiler_tof AS (
    SELECT DISTINCT ON (name) name, tof_days FROM (
      SELECT elem->>'name' AS name,
             (left(COALESCE(elem->>'processingDate', elem->>'processing_date'), 10)::date
              - left(COALESCE(elem->>'hatchDate', elem->>'hatch_date'), 10)::date) AS tof_days
        FROM jsonb_array_elements(
               COALESCE((SELECT data::jsonb FROM public.app_store WHERE key = 'ppp-v4'), '[]'::jsonb)
             ) AS elem
       WHERE COALESCE(elem->>'processingDate', elem->>'processing_date') ~ '^\d{4}-\d{2}-\d{2}'
         AND COALESCE(elem->>'hatchDate', elem->>'hatch_date') ~ '^\d{4}-\d{2}-\d{2}'
         AND NULLIF(btrim(COALESCE(elem->>'name', '')), '') IS NOT NULL
    ) x
    ORDER BY name
  )
  SELECT COALESCE(jsonb_agg(row ORDER BY row->>'program', (row->>'processing_date')), '[]'::jsonb)
    INTO v_out
  FROM (
    SELECT jsonb_build_object(
      'id', r.id, 'record_type', r.record_type, 'program', r.program, 'title', r.title,
      'processing_date', r.processing_date, 'status', r.status, 'completed_at', r.completed_at,
      'processor', r.processor, 'number_processed', r.number_processed, 'customer', r.customer,
      'source_kind', r.source_kind, 'source_id', r.source_id, 'archived', r.archived,
      'fields', r.fields, 'historical_snapshot', r.historical_snapshot,
      'subtask_total', COALESCE(st.total, 0), 'subtask_done', COALESCE(st.done, 0),
      'time_on_farm_days', bt.tof_days
    ) AS row
    FROM public.processing_records r
    LEFT JOIN LATERAL (
      SELECT count(*) AS total, count(*) FILTER (WHERE s.done) AS done
      FROM public.processing_subtasks s WHERE s.record_id = r.id
    ) st ON true
    LEFT JOIN broiler_tof bt
      ON bt.name = r.source_id AND r.program = 'broiler' AND r.record_type = 'planner_batch'
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

CREATE OR REPLACE FUNCTION public.get_processing_record(p_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE
AS $fn$
DECLARE v_rec jsonb; v_subs jsonb; v_atts jsonb; v_blockers text[]; v_tof int;
BEGIN
  PERFORM public._processing_require_operational();
  SELECT to_jsonb(r) INTO v_rec FROM public.processing_records r WHERE r.id = p_id;
  IF v_rec IS NULL THEN
    RETURN NULL;
  END IF;

  -- Broiler planner rows get server-derived Time-on-Farm from ppp-v4 (same source
  -- + formula as the list RPC); everything else stays NULL and the client falls
  -- back to the record snapshot.
  IF (v_rec->>'program') = 'broiler'
     AND (v_rec->>'record_type') = 'planner_batch'
     AND NULLIF(btrim(COALESCE(v_rec->>'source_id', '')), '') IS NOT NULL THEN
    SELECT (left(COALESCE(elem->>'processingDate', elem->>'processing_date'), 10)::date
            - left(COALESCE(elem->>'hatchDate', elem->>'hatch_date'), 10)::date)
      INTO v_tof
      FROM jsonb_array_elements(
             COALESCE((SELECT data::jsonb FROM public.app_store WHERE key = 'ppp-v4'), '[]'::jsonb)
           ) AS elem
     WHERE elem->>'name' = (v_rec->>'source_id')
       AND COALESCE(elem->>'processingDate', elem->>'processing_date') ~ '^\d{4}-\d{2}-\d{2}'
       AND COALESCE(elem->>'hatchDate', elem->>'hatch_date') ~ '^\d{4}-\d{2}-\d{2}'
     LIMIT 1;
  END IF;
  v_rec := v_rec || jsonb_build_object('time_on_farm_days', v_tof);

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

NOTIFY pgrst, 'reload schema';
