-- ============================================================================
-- 159_processing_reconciliation_workbench.sql
-- ----------------------------------------------------------------------------
-- Reconciliation workbench support (Codex-scoped). Read-derived + narrow SECDEF
-- RPCs; NO new tables and NO CHECK widening — the existing constraints already
-- cover every state used here:
--   processing_asana_links.match_status: matched | historical | needs_review |
--     duplicate_blocked | milestone   (156/157)
--   processing_records.record_type:     planner_batch | asana_historical |
--     milestone | import_exception     (156)
--
-- 1. resolve_processing_asana_link REISSUE — assigning ANY existing link to a
--    planner record now works for no-candidate import_exception / pig rows too
--    (it already accepted any target; this adds the reparent+retire safety).
--    When a link is reassigned OFF an Asana-owned placeholder record
--    (asana_historical / import_exception) that THIS link solely owns, any
--    already-imported subtasks / comments / attachments are reparented to the new
--    record and the emptied placeholder is archived (not deleted — provenance
--    preserved). Defensive: sync_review_queue imports no artifacts, so nothing is
--    reparented in the review-queue phase; this protects a later artifacts import.
--    A shared placeholder (another link still points at it — e.g. a pig trip with
--    N sub-batch links) is never reparented or archived by moving one link.
--
-- 2. triage_processing_asana_record — reclassify an Asana-owned record to
--    milestone / asana_historical, or dismiss it (archive). NEVER touches a
--    planner_batch. Used for the ~6 planning-note "import exceptions" and any
--    row that should be history/not-a-batch.
--
-- 3. supersede_processing_asana_duplicate — block a duplicate Asana task's link
--    (match_status='duplicate_blocked'), recording the canonical record as a
--    provenance note, and archive the duplicate's OWN orphaned Asana placeholder.
--    Never deletes Asana provenance (raw_asana_snapshot kept) and never archives
--    a planner_batch or the canonical link.
--
-- 4. list_processing_reconciliation ENRICH — returns, per link, a derived bucket
--    (matched / historical / milestone / duplicate_blocked / ambiguous /
--    import_exception / needs_review), the linked record facts, resolved
--    candidate record details, and duplicate-group membership, plus top-level
--    counts and the duplicate-group report — enough for the workbench without
--    client cross-referencing. Deny-all RLS + RPC-only access preserved.
--
-- Gate: farm_team/management/admin via _processing_require_operational() (matches
-- the existing resolve/ack). exec_sql-in-PROD forbidden; apply via psql.
-- Depends on: 156 (records + _processing_require_operational), 157 (links +
-- resolve/ack/list_processing_reconciliation).
-- ============================================================================

-- ── 1. resolve_processing_asana_link (reparent + retire placeholder) ─────────
CREATE OR REPLACE FUNCTION public.resolve_processing_asana_link(p_asana_gid text, p_record_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_caller   uuid := auth.uid();
  v_old_rec  text;
  v_old_type text;
  v_retired  text := NULL;
BEGIN
  PERFORM public._processing_require_operational();

  SELECT processing_record_id INTO v_old_rec
    FROM public.processing_asana_links WHERE asana_gid = p_asana_gid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: link not found';
  END IF;
  IF p_record_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.processing_records WHERE id = p_record_id) THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: target record not found';
  END IF;

  -- Reassigning to a DIFFERENT real record: if the OLD record is an Asana-owned
  -- placeholder that ONLY this link owns, reparent its artifacts to the new
  -- record and archive the emptied placeholder. A shared placeholder (another
  -- link points at it) is left untouched.
  IF p_record_id IS NOT NULL AND v_old_rec IS NOT NULL AND v_old_rec <> p_record_id THEN
    SELECT record_type INTO v_old_type FROM public.processing_records WHERE id = v_old_rec;
    IF v_old_type IN ('asana_historical', 'import_exception')
       AND NOT EXISTS (
         SELECT 1 FROM public.processing_asana_links
          WHERE processing_record_id = v_old_rec AND asana_gid <> p_asana_gid
       ) THEN
      UPDATE public.processing_subtasks    SET record_id = p_record_id, updated_at = now() WHERE record_id = v_old_rec;
      UPDATE public.processing_attachments SET record_id = p_record_id                     WHERE record_id = v_old_rec;
      UPDATE public.comments SET entity_id = p_record_id
        WHERE entity_type = 'processing.record' AND entity_id = v_old_rec;
      UPDATE public.processing_records SET archived = true, updated_at = now() WHERE id = v_old_rec;
      v_retired := v_old_rec;
    END IF;
  END IF;

  UPDATE public.processing_asana_links SET
    processing_record_id = p_record_id,
    match_status = CASE WHEN p_record_id IS NULL THEN 'needs_review' ELSE 'matched' END,
    match_method = CASE WHEN p_record_id IS NULL THEN 'none' ELSE 'manual_crosswalk' END,
    matched_by = v_caller, matched_at = now(), updated_at = now()
  WHERE asana_gid = p_asana_gid;

  RETURN jsonb_build_object('ok', true, 'asana_gid', p_asana_gid, 'record_id', p_record_id, 'retired_record', v_retired);
END
$fn$;
REVOKE ALL ON FUNCTION public.resolve_processing_asana_link(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_processing_asana_link(text, text) TO authenticated;

-- ── 2. triage_processing_asana_record (milestone / historical / dismiss) ─────
CREATE OR REPLACE FUNCTION public.triage_processing_asana_record(p_record_id text, p_action text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_type text;
BEGIN
  PERFORM public._processing_require_operational();

  SELECT record_type INTO v_type FROM public.processing_records WHERE id = p_record_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: record not found';
  END IF;
  -- Never reclassify a Planner-owned batch; triage is for Asana-owned rows only.
  IF v_type = 'planner_batch' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: cannot triage a planner_batch record';
  END IF;

  IF p_action = 'milestone' THEN
    UPDATE public.processing_records
       SET record_type = 'milestone', archived = false, updated_at = now()
     WHERE id = p_record_id;
    UPDATE public.processing_asana_links
       SET match_status = 'milestone', match_method = 'milestone', updated_at = now()
     WHERE processing_record_id = p_record_id;
  ELSIF p_action = 'historical' THEN
    UPDATE public.processing_records
       SET record_type = 'asana_historical', archived = false, updated_at = now()
     WHERE id = p_record_id;
    UPDATE public.processing_asana_links
       SET match_status = 'historical', match_method = 'historical', updated_at = now()
     WHERE processing_record_id = p_record_id;
  ELSIF p_action = 'dismiss' THEN
    -- Not-a-batch: hide the record. The link is retained (provenance) but the
    -- archived record drops out of the active calendar + the workbench queues.
    UPDATE public.processing_records SET archived = true, updated_at = now() WHERE id = p_record_id;
  ELSE
    RAISE EXCEPTION 'PROCESSING_VALIDATION: invalid triage action %', COALESCE(p_action, 'null');
  END IF;

  RETURN jsonb_build_object('ok', true, 'record_id', p_record_id, 'action', p_action);
END
$fn$;
REVOKE ALL ON FUNCTION public.triage_processing_asana_record(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.triage_processing_asana_record(text, text) TO authenticated;

-- ── 3. supersede_processing_asana_duplicate (block a duplicate Asana task) ───
CREATE OR REPLACE FUNCTION public.supersede_processing_asana_duplicate(
  p_asana_gid text,
  p_canonical_record_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_caller   uuid := auth.uid();
  v_old_rec  text;
  v_old_type text;
  v_retired  text := NULL;
BEGIN
  PERFORM public._processing_require_operational();

  SELECT processing_record_id INTO v_old_rec
    FROM public.processing_asana_links WHERE asana_gid = p_asana_gid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: link not found';
  END IF;
  IF p_canonical_record_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.processing_records WHERE id = p_canonical_record_id) THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: canonical record not found';
  END IF;

  -- Block the duplicate link (provenance kept in raw_asana_snapshot); note the
  -- canonical record as a suggestion. The link mirrors nothing while blocked.
  UPDATE public.processing_asana_links SET
    processing_record_id = NULL,
    match_status = 'duplicate_blocked',
    match_method = 'none',
    candidate_record_ids = CASE WHEN p_canonical_record_id IS NOT NULL
                                THEN jsonb_build_array(p_canonical_record_id)
                                ELSE candidate_record_ids END,
    matched_by = v_caller, matched_at = now(), updated_at = now()
  WHERE asana_gid = p_asana_gid;

  -- Archive the duplicate's OWN Asana placeholder if it solely owned one. Never a
  -- planner_batch, never the canonical record.
  IF v_old_rec IS NOT NULL AND v_old_rec IS DISTINCT FROM p_canonical_record_id THEN
    SELECT record_type INTO v_old_type FROM public.processing_records WHERE id = v_old_rec;
    IF v_old_type IN ('asana_historical', 'import_exception')
       AND NOT EXISTS (
         SELECT 1 FROM public.processing_asana_links
          WHERE processing_record_id = v_old_rec AND asana_gid <> p_asana_gid
       ) THEN
      UPDATE public.processing_records SET archived = true, updated_at = now() WHERE id = v_old_rec;
      v_retired := v_old_rec;
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'asana_gid', p_asana_gid,
                            'canonical_record_id', p_canonical_record_id, 'retired_record', v_retired);
END
$fn$;
REVOKE ALL ON FUNCTION public.supersede_processing_asana_duplicate(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.supersede_processing_asana_duplicate(text, text) TO authenticated;

-- ── 4. list_processing_reconciliation ENRICH ────────────────────────────────
CREATE OR REPLACE FUNCTION public.list_processing_reconciliation()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE
AS $fn$
DECLARE
  v_links jsonb;
  v_dupes jsonb;
  v_planner_only int;
BEGIN
  PERFORM public._processing_require_operational();

  -- Duplicate-group set: UNRESOLVED work only — (program, code) shared by >=2
  -- ACTIVE links. A link is inactive for duplicate purposes when it is blocked
  -- (duplicate_blocked) OR its record was dismissed (archived Asana-owned
  -- placeholder). Once the extras are superseded/dismissed the group drops out;
  -- blocked provenance is still reported via duplicate_blocked_count.
  WITH dup AS (
    SELECT l.program, l.asana_batch_code, count(*) AS cnt,
           jsonb_agg(l.asana_gid ORDER BY l.asana_gid) AS gids
      FROM public.processing_asana_links l
      LEFT JOIN public.processing_records r ON r.id = l.processing_record_id
     WHERE l.asana_batch_code IS NOT NULL AND btrim(l.asana_batch_code) <> ''
       AND l.match_status <> 'duplicate_blocked'
       AND NOT COALESCE(r.archived AND r.record_type IN ('asana_historical', 'import_exception'), false)
     GROUP BY l.program, l.asana_batch_code
    HAVING count(*) >= 2
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'program', program, 'code', asana_batch_code, 'count', cnt, 'asana_gids', gids
         ) ORDER BY program, asana_batch_code), '[]'::jsonb)
    INTO v_dupes FROM dup;

  SELECT COALESCE(jsonb_agg(
           to_jsonb(l)
           || jsonb_build_object(
                'bucket',
                CASE
                  -- A dismissed (archived) Asana-owned placeholder is resolved work:
                  -- it must not sit in the active ambiguous/import_exception queues.
                  WHEN rec.archived = true AND rec.record_type IN ('asana_historical', 'import_exception')
                       THEN 'dismissed'
                  WHEN l.match_status = 'matched'           THEN 'matched'
                  WHEN l.match_status = 'historical'        THEN 'historical'
                  WHEN l.match_status = 'milestone'         THEN 'milestone'
                  WHEN l.match_status = 'duplicate_blocked' THEN 'duplicate_blocked'
                  WHEN l.match_status = 'needs_review'
                       AND jsonb_array_length(l.candidate_record_ids) > 0 THEN 'ambiguous'
                  WHEN l.match_status = 'needs_review'
                       AND rec.record_type = 'import_exception' THEN 'import_exception'
                  ELSE 'needs_review'
                END,
                'has_drift', (l.drift <> '{}'::jsonb),
                'drift_open', (l.drift <> '{}'::jsonb AND l.drift_acknowledged_at IS NULL),
                'duplicate_group',
                CASE WHEN l.asana_batch_code IS NOT NULL AND btrim(l.asana_batch_code) <> ''
                          AND l.match_status <> 'duplicate_blocked'
                          AND NOT COALESCE(rec.archived AND rec.record_type IN ('asana_historical', 'import_exception'), false)
                          AND EXISTS (
                            SELECT 1 FROM public.processing_asana_links l2
                              LEFT JOIN public.processing_records r2 ON r2.id = l2.processing_record_id
                             WHERE l2.program IS NOT DISTINCT FROM l.program
                               AND l2.asana_batch_code = l.asana_batch_code
                               AND l2.asana_gid <> l.asana_gid
                               AND l2.match_status <> 'duplicate_blocked'
                               AND NOT COALESCE(r2.archived AND r2.record_type IN ('asana_historical', 'import_exception'), false))
                     THEN COALESCE(l.program, '?') || '::' || l.asana_batch_code ELSE NULL END,
                'record',
                CASE WHEN rec.id IS NULL THEN NULL ELSE jsonb_build_object(
                  'id', rec.id, 'record_type', rec.record_type, 'title', rec.title,
                  'program', rec.program, 'source_kind', rec.source_kind, 'source_id', rec.source_id,
                  'processing_date', rec.processing_date, 'number_processed', rec.number_processed,
                  'archived', rec.archived) END,
                'candidates',
                COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                           'id', c.id, 'title', c.title, 'record_type', c.record_type,
                           'program', c.program, 'source_kind', c.source_kind, 'source_id', c.source_id,
                           'processing_date', c.processing_date, 'number_processed', c.number_processed)
                         ORDER BY c.processing_date)
                    FROM jsonb_array_elements_text(l.candidate_record_ids) cid
                    JOIN public.processing_records c ON c.id = cid.value
                ), '[]'::jsonb)
              )
           ORDER BY l.created_at DESC), '[]'::jsonb)
    INTO v_links
    FROM public.processing_asana_links l
    LEFT JOIN public.processing_records rec ON rec.id = l.processing_record_id;

  SELECT count(*) INTO v_planner_only
    FROM public.processing_records r
   WHERE r.record_type = 'planner_batch'
     AND r.archived = false
     AND NOT EXISTS (SELECT 1 FROM public.processing_asana_links l WHERE l.processing_record_id = r.id);

  RETURN jsonb_build_object(
    'links', v_links,
    'duplicate_groups', v_dupes,
    'planner_only_count', v_planner_only,
    -- Active-work counts MIRROR the workbench queues: exclude dismissed archived
    -- Asana-owned placeholders (same guard as the bucket derivation).
    'needs_review_count', (SELECT count(*) FROM public.processing_asana_links l
                             LEFT JOIN public.processing_records r ON r.id = l.processing_record_id
                            WHERE l.match_status = 'needs_review' AND jsonb_array_length(l.candidate_record_ids) > 0
                              AND NOT COALESCE(r.archived AND r.record_type IN ('asana_historical', 'import_exception'), false)),
    'import_exception_count', (SELECT count(*) FROM public.processing_asana_links l
                                JOIN public.processing_records r ON r.id = l.processing_record_id
                               WHERE l.match_status = 'needs_review' AND r.record_type = 'import_exception'
                                 AND NOT COALESCE(r.archived AND r.record_type IN ('asana_historical', 'import_exception'), false)),
    'dismissed_count', (SELECT count(*) FROM public.processing_asana_links l
                          JOIN public.processing_records r ON r.id = l.processing_record_id
                         WHERE r.archived = true AND r.record_type IN ('asana_historical', 'import_exception')),
    'matched_count',      (SELECT count(*) FROM public.processing_asana_links WHERE match_status = 'matched'),
    'historical_count',   (SELECT count(*) FROM public.processing_asana_links WHERE match_status = 'historical'),
    'milestone_count',    (SELECT count(*) FROM public.processing_asana_links WHERE match_status = 'milestone'),
    'duplicate_blocked_count', (SELECT count(*) FROM public.processing_asana_links WHERE match_status = 'duplicate_blocked'),
    'drift_count',        (SELECT count(*) FROM public.processing_asana_links
                            WHERE drift <> '{}'::jsonb AND drift_acknowledged_at IS NULL)
  );
END
$fn$;
REVOKE ALL ON FUNCTION public.list_processing_reconciliation() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_processing_reconciliation() TO authenticated;

NOTIFY pgrst, 'reload schema';
