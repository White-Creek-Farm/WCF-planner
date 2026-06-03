-- ============================================================================
-- 081_processing_detach_activity_rpcs.sql
-- ----------------------------------------------------------------------------
-- Audit-grade transactional processing-detach RPCs for the AUTHENTICATED app
-- (CattleBatchPage / SheepBatchPage). These mirror the client-side
-- detachCowFromBatch / detachSheepFromBatch helpers in
-- src/lib/cattleProcessingBatch.js and src/lib/sheepProcessingBatch.js, but
-- make the multi-table mutation AND the Activity event atomic: if any step
-- (batch update, animal revert, audit row, weigh-in clear, Activity insert)
-- fails, the whole detach rolls back.
--
-- Permission shape: these match the page edit rights (admin OR management
-- only) and are enforced IN the RPC, not just hidden in the UI. SECURITY
-- DEFINER is used to make the cross-table write atomic, NOT to broaden who may
-- detach. REVOKE from PUBLIC/anon; GRANT to authenticated. The role gate
-- inside the function blocks any authenticated-but-non-privileged caller.
--
-- Scope note: the PUBLIC WeighInsWebform anon detach path is intentionally NOT
-- converted here. It still calls the client helpers directly. These RPCs are
-- never granted to anon and have no profile actor fallback.
--
-- Behavior preserved from the client helpers:
--   * Resolve prior herd/flock via weigh_ins.prior_herd_or_flock first, then
--     the latest matching transfers row (reason='processing_batch'); never
--     guess — return ok=false reason=no_prior_herd / no_prior_flock instead.
--   * Remove the animal from cows_detail/sheep_detail and recompute
--     total_live_weight / total_hanging_weight (round to 0.1; null when <= 0).
--   * Revert the animal's herd/flock to the prior value and clear
--     processing_batch_id.
--   * Insert an undo transfer audit row (reason='processing_batch_undo').
--   * Clear target_processing_batch_id AND send_to_processor on every matching
--     weigh_in (the chip-clear behavior from the client helpers).
--   * Log ONE field.updated Activity event on the cattle.processing /
--     sheep.processing batch entity (same transaction) — body "Detached #TAG
--     from batch" — replacing the page's best-effort logEvent call.
--
-- Return shape (jsonb):
--   ok=true:  {ok, reason:'detached', tag, prior_herd|prior_flock, batch_id,
--             weigh_in_ids_cleared, transfer_id, event_id}
--   ok=false: {ok:false, reason, tag?, batch_id?}  (reason in:
--             bad_args | no_cow|no_sheep | no_batch | not_in_batch |
--             no_prior_herd|no_prior_flock)
--
-- Auth/role violations RAISE (caller should never reach them through the UI).
--
-- Apply order: TEST first (this lane), PROD after explicit lane approval.
-- ============================================================================

-- ── detach_cattle_from_processing_batch ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.detach_cattle_from_processing_batch(
  p_cattle_id   text,
  p_batch_id    text,
  p_team_member text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller     uuid := auth.uid();
  v_role       text;
  v_tag        text;
  v_pbid       text;
  v_detail     jsonb;
  v_new_detail jsonb;
  v_live       numeric;
  v_hang       numeric;
  v_prior      text;
  v_tr_id      text;
  v_ae_id      text;
  v_cleared    jsonb;
  v_label      text;
  v_batch_label text;
BEGIN
  -- 1. Authenticate
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'detach_cattle_from_processing_batch: authenticated caller required';
  END IF;

  -- 2. Authorize: admin OR management only (matches page edit rights)
  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('admin', 'management') THEN
    RAISE EXCEPTION 'detach_cattle_from_processing_batch: caller role % cannot detach', COALESCE(v_role, 'null');
  END IF;

  -- 3. Validate args
  IF p_cattle_id IS NULL OR p_cattle_id = '' OR p_batch_id IS NULL OR p_batch_id = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_args');
  END IF;

  -- 4. Load the animal. NOTE: no deleted_at filter — processing-batch helpers
  --    resolve animals by id in admin context (see PROJECT.md Cattle/Sheep).
  SELECT c.tag, c.processing_batch_id
    INTO v_tag, v_pbid
    FROM public.cattle c
    WHERE c.id = p_cattle_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_cow');
  END IF;

  -- 5. The animal must currently belong to this batch.
  IF v_pbid IS DISTINCT FROM p_batch_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_in_batch', 'tag', v_tag, 'batch_id', p_batch_id);
  END IF;

  -- 6. Load the batch row.
  SELECT b.cows_detail, b.name
    INTO v_detail, v_batch_label
    FROM public.cattle_processing_batches b
    WHERE b.id = p_batch_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_batch', 'tag', v_tag, 'batch_id', p_batch_id);
  END IF;

  -- 7a. Resolve prior herd from the most recent matching weigh_in.
  SELECT w.prior_herd_or_flock
    INTO v_prior
    FROM public.weigh_ins w
    WHERE w.target_processing_batch_id = p_batch_id
      AND w.tag = COALESCE(v_tag, '')
      AND w.prior_herd_or_flock IS NOT NULL
    ORDER BY w.entered_at DESC NULLS LAST
    LIMIT 1;

  -- 7b. Fallback to the latest matching processing_batch transfer audit row.
  IF v_prior IS NULL THEN
    SELECT t.from_herd
      INTO v_prior
      FROM public.cattle_transfers t
      WHERE t.cattle_id = p_cattle_id
        AND t.reason = 'processing_batch'
        AND t.reference_id = p_batch_id
        AND t.from_herd IS NOT NULL
      ORDER BY t.transferred_at DESC NULLS LAST
      LIMIT 1;
  END IF;

  -- 7c. Never guess. Block with a clear reason.
  IF v_prior IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_prior_herd', 'tag', v_tag, 'batch_id', p_batch_id);
  END IF;

  -- 8. Remove this animal from cows_detail and recompute totals.
  SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
    INTO v_new_detail
    FROM jsonb_array_elements(COALESCE(v_detail, '[]'::jsonb)) elem
    WHERE elem->>'cattle_id' IS DISTINCT FROM p_cattle_id;

  SELECT SUM(NULLIF(elem->>'live_weight', '')::numeric),
         SUM(NULLIF(elem->>'hanging_weight', '')::numeric)
    INTO v_live, v_hang
    FROM jsonb_array_elements(v_new_detail) elem;

  UPDATE public.cattle_processing_batches
    SET cows_detail = v_new_detail,
        total_live_weight    = CASE WHEN COALESCE(v_live, 0) > 0 THEN round(v_live, 1) ELSE NULL END,
        total_hanging_weight = CASE WHEN COALESCE(v_hang, 0) > 0 THEN round(v_hang, 1) ELSE NULL END
    WHERE id = p_batch_id;

  -- 9. Revert the animal.
  UPDATE public.cattle
    SET herd = v_prior,
        processing_batch_id = NULL
    WHERE id = p_cattle_id;

  -- 10. Undo transfer audit row (same transaction).
  v_tr_id := 'tr-' || gen_random_uuid()::text;
  INSERT INTO public.cattle_transfers (id, cattle_id, from_herd, to_herd, reason, reference_id, team_member)
    VALUES (v_tr_id, p_cattle_id, 'processed', v_prior, 'processing_batch_undo', p_batch_id, p_team_member);

  -- 11. Clear matching weigh_ins (link + processor flag) and collect ids.
  WITH cleared AS (
    UPDATE public.weigh_ins
      SET target_processing_batch_id = NULL,
          send_to_processor = false
      WHERE target_processing_batch_id = p_batch_id
        AND tag = COALESCE(v_tag, '')
      RETURNING id
  )
  SELECT COALESCE(jsonb_agg(id), '[]'::jsonb) INTO v_cleared FROM cleared;

  -- 12. field.updated Activity event on the cattle.processing batch entity.
  v_label := COALESCE(NULLIF(v_tag, ''), p_cattle_id);
  v_ae_id := 'ae-' || gen_random_uuid()::text;
  INSERT INTO public.activity_events (
    id, entity_type, entity_id, actor_profile_id, event_type, body, payload
  ) VALUES (
    v_ae_id,
    'cattle.processing',
    p_batch_id,
    v_caller,
    'field.updated',
    'Detached #' || v_label || ' from batch',
    jsonb_build_object(
      'entity_label', COALESCE(NULLIF(v_batch_label, ''), p_batch_id),
      'field', 'cows_detail',
      'action', 'detach',
      'cattle_id', p_cattle_id,
      'tag', v_tag,
      'prior_herd', v_prior,
      'transfer_id', v_tr_id,
      'weigh_in_ids_cleared', v_cleared,
      'team_member', p_team_member
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'reason', 'detached',
    'tag', v_tag,
    'prior_herd', v_prior,
    'batch_id', p_batch_id,
    'weigh_in_ids_cleared', v_cleared,
    'transfer_id', v_tr_id,
    'event_id', v_ae_id
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.detach_cattle_from_processing_batch(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.detach_cattle_from_processing_batch(text, text, text) TO authenticated;

-- ── detach_sheep_from_processing_batch ──────────────────────────────────────

CREATE OR REPLACE FUNCTION public.detach_sheep_from_processing_batch(
  p_sheep_id    text,
  p_batch_id    text,
  p_team_member text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller     uuid := auth.uid();
  v_role       text;
  v_tag        text;
  v_pbid       text;
  v_detail     jsonb;
  v_new_detail jsonb;
  v_live       numeric;
  v_hang       numeric;
  v_prior      text;
  v_tr_id      text;
  v_ae_id      text;
  v_cleared    jsonb;
  v_label      text;
  v_batch_label text;
BEGIN
  -- 1. Authenticate
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'detach_sheep_from_processing_batch: authenticated caller required';
  END IF;

  -- 2. Authorize: admin OR management only (matches page edit rights)
  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('admin', 'management') THEN
    RAISE EXCEPTION 'detach_sheep_from_processing_batch: caller role % cannot detach', COALESCE(v_role, 'null');
  END IF;

  -- 3. Validate args
  IF p_sheep_id IS NULL OR p_sheep_id = '' OR p_batch_id IS NULL OR p_batch_id = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_args');
  END IF;

  -- 4. Load the animal (no deleted_at filter — see cattle note above).
  SELECT s.tag, s.processing_batch_id
    INTO v_tag, v_pbid
    FROM public.sheep s
    WHERE s.id = p_sheep_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_sheep');
  END IF;

  -- 5. The animal must currently belong to this batch.
  IF v_pbid IS DISTINCT FROM p_batch_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_in_batch', 'tag', v_tag, 'batch_id', p_batch_id);
  END IF;

  -- 6. Load the batch row.
  SELECT b.sheep_detail, b.name
    INTO v_detail, v_batch_label
    FROM public.sheep_processing_batches b
    WHERE b.id = p_batch_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_batch', 'tag', v_tag, 'batch_id', p_batch_id);
  END IF;

  -- 7a. Resolve prior flock from the most recent matching weigh_in.
  SELECT w.prior_herd_or_flock
    INTO v_prior
    FROM public.weigh_ins w
    WHERE w.target_processing_batch_id = p_batch_id
      AND w.tag = COALESCE(v_tag, '')
      AND w.prior_herd_or_flock IS NOT NULL
    ORDER BY w.entered_at DESC NULLS LAST
    LIMIT 1;

  -- 7b. Fallback to the latest matching processing_batch transfer audit row.
  IF v_prior IS NULL THEN
    SELECT t.from_flock
      INTO v_prior
      FROM public.sheep_transfers t
      WHERE t.sheep_id = p_sheep_id
        AND t.reason = 'processing_batch'
        AND t.reference_id = p_batch_id
        AND t.from_flock IS NOT NULL
      ORDER BY t.transferred_at DESC NULLS LAST
      LIMIT 1;
  END IF;

  -- 7c. Never guess. Block with a clear reason.
  IF v_prior IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_prior_flock', 'tag', v_tag, 'batch_id', p_batch_id);
  END IF;

  -- 8. Remove this animal from sheep_detail and recompute totals.
  SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
    INTO v_new_detail
    FROM jsonb_array_elements(COALESCE(v_detail, '[]'::jsonb)) elem
    WHERE elem->>'sheep_id' IS DISTINCT FROM p_sheep_id;

  SELECT SUM(NULLIF(elem->>'live_weight', '')::numeric),
         SUM(NULLIF(elem->>'hanging_weight', '')::numeric)
    INTO v_live, v_hang
    FROM jsonb_array_elements(v_new_detail) elem;

  UPDATE public.sheep_processing_batches
    SET sheep_detail = v_new_detail,
        total_live_weight    = CASE WHEN COALESCE(v_live, 0) > 0 THEN round(v_live, 1) ELSE NULL END,
        total_hanging_weight = CASE WHEN COALESCE(v_hang, 0) > 0 THEN round(v_hang, 1) ELSE NULL END
    WHERE id = p_batch_id;

  -- 9. Revert the animal.
  UPDATE public.sheep
    SET flock = v_prior,
        processing_batch_id = NULL
    WHERE id = p_sheep_id;

  -- 10. Undo transfer audit row (same transaction).
  v_tr_id := 'tr-' || gen_random_uuid()::text;
  INSERT INTO public.sheep_transfers (id, sheep_id, from_flock, to_flock, reason, reference_id, team_member)
    VALUES (v_tr_id, p_sheep_id, 'processed', v_prior, 'processing_batch_undo', p_batch_id, p_team_member);

  -- 11. Clear matching weigh_ins (link + processor flag) and collect ids.
  WITH cleared AS (
    UPDATE public.weigh_ins
      SET target_processing_batch_id = NULL,
          send_to_processor = false
      WHERE target_processing_batch_id = p_batch_id
        AND tag = COALESCE(v_tag, '')
      RETURNING id
  )
  SELECT COALESCE(jsonb_agg(id), '[]'::jsonb) INTO v_cleared FROM cleared;

  -- 12. field.updated Activity event on the sheep.processing batch entity.
  v_label := COALESCE(NULLIF(v_tag, ''), p_sheep_id);
  v_ae_id := 'ae-' || gen_random_uuid()::text;
  INSERT INTO public.activity_events (
    id, entity_type, entity_id, actor_profile_id, event_type, body, payload
  ) VALUES (
    v_ae_id,
    'sheep.processing',
    p_batch_id,
    v_caller,
    'field.updated',
    'Detached #' || v_label || ' from batch',
    jsonb_build_object(
      'entity_label', COALESCE(NULLIF(v_batch_label, ''), p_batch_id),
      'field', 'sheep_detail',
      'action', 'detach',
      'sheep_id', p_sheep_id,
      'tag', v_tag,
      'prior_flock', v_prior,
      'transfer_id', v_tr_id,
      'weigh_in_ids_cleared', v_cleared,
      'team_member', p_team_member
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'reason', 'detached',
    'tag', v_tag,
    'prior_flock', v_prior,
    'batch_id', p_batch_id,
    'weigh_in_ids_cleared', v_cleared,
    'transfer_id', v_tr_id,
    'event_id', v_ae_id
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.detach_sheep_from_processing_batch(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.detach_sheep_from_processing_batch(text, text, text) TO authenticated;

-- ── Reload PostgREST schema cache ───────────────────────────────────────────

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- End of 081_processing_detach_activity_rpcs.sql
-- ============================================================================
