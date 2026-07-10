-- ============================================================================
-- 170_processing_detach_farm_team.sql
-- ----------------------------------------------------------------------------
-- Completes the migration-081 processing-detach cutover for the login-gated
-- cattle/sheep weigh-in workflows.
--
-- Permission contract:
--   * admin and management retain their migration-081 access unchanged;
--   * farm_team may detach only when its program_access is NULL/empty (the
--     project's canonical "all programs" representation) or contains the
--     matching cattle/sheep program;
--   * light, equipment_tech, inactive, missing-profile, anon, and
--     unauthenticated callers fail closed.
--
-- The p_team_member argument remains in the signature for backwards-compatible
-- PostgREST calls, but is no longer trusted. Transfer and Activity attribution
-- are stamped from the authenticated caller's profile name (email fallback).
--
-- The business behavior and jsonb return shape from migration 081 are
-- preserved. For the migration-096 attach / migration-170 detach pair, lock
-- order is batch, matching weigh-ins, then animal. Membership is revalidated
-- after the animal lock so concurrent attach/detach work does not introduce an
-- inversion or restore a stale detail list. This is not a claim that every
-- processing lifecycle RPC now shares that order: migration 100's sheep batch
-- delete still locks animal rows before the batch and remains an excluded
-- follow-up hardening lane.
-- ============================================================================

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
  v_caller         uuid := auth.uid();
  v_role           text;
  v_program_access text[];
  v_actor_name     text;
  v_tag            text;
  v_pbid           text;
  v_detail         jsonb;
  v_new_detail     jsonb;
  v_live           numeric;
  v_hang           numeric;
  v_prior          text;
  v_tr_id          text;
  v_ae_id          text;
  v_cleared        jsonb;
  v_label          text;
  v_batch_label    text;
BEGIN
  -- 1. Authenticate and resolve the server-owned caller identity.
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'detach_cattle_from_processing_batch: authenticated caller required';
  END IF;

  SELECT p.role,
         p.program_access,
         COALESCE(NULLIF(btrim(p.full_name), ''), NULLIF(btrim(p.email), ''))
    INTO v_role, v_program_access, v_actor_name
    FROM public.profiles p
    WHERE p.id = v_caller;

  -- 2. Preserve admin/management and admit only program-authorized farm_team.
  IF v_role IS NULL OR v_role NOT IN ('admin', 'management', 'farm_team') THEN
    RAISE EXCEPTION 'detach_cattle_from_processing_batch: caller role % cannot detach', COALESCE(v_role, 'null');
  END IF;
  IF v_role = 'farm_team'
     AND v_program_access IS NOT NULL
     AND array_length(v_program_access, 1) IS NOT NULL
     AND NOT COALESCE('cattle' = ANY(v_program_access), false) THEN
    RAISE EXCEPTION 'detach_cattle_from_processing_batch: cattle program access required';
  END IF;

  -- 3. Validate args after authorization so denied callers cannot probe rows.
  IF p_cattle_id IS NULL OR p_cattle_id = '' OR p_batch_id IS NULL OR p_batch_id = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_args');
  END IF;

  -- 4. Take an unlocked animal snapshot to preserve migration-081's early
  -- no_cow/not_in_batch results. Membership is revalidated after all locks.
  -- No deleted_at filter preserves migration-081 behavior.
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

  -- 6. Lock in migration-096 order: batch -> weigh-ins -> animal.
  SELECT b.cows_detail, b.name
    INTO v_detail, v_batch_label
    FROM public.cattle_processing_batches b
    WHERE b.id = p_batch_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_batch', 'tag', v_tag, 'batch_id', p_batch_id);
  END IF;

  -- Migration 096 locks its selected weigh-ins before the animal. Lock every
  -- row already targeting this batch so detach uses the same order even when
  -- more than one historical entry shares an animal tag.
  PERFORM 1
    FROM public.weigh_ins w
    WHERE w.target_processing_batch_id = p_batch_id
    ORDER BY w.id
    FOR UPDATE;

  SELECT c.tag, c.processing_batch_id
    INTO v_tag, v_pbid
    FROM public.cattle c
    WHERE c.id = p_cattle_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_cow');
  END IF;
  IF v_pbid IS DISTINCT FROM p_batch_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_in_batch', 'tag', v_tag, 'batch_id', p_batch_id);
  END IF;

  -- 7a. Resolve prior herd from the most recent matching weigh-in.
  SELECT w.prior_herd_or_flock
    INTO v_prior
    FROM public.weigh_ins w
    WHERE w.target_processing_batch_id = p_batch_id
      AND w.tag = COALESCE(v_tag, '')
      AND w.prior_herd_or_flock IS NOT NULL
    ORDER BY w.entered_at DESC NULLS LAST
    LIMIT 1;

  -- 7b. Fall back to the latest matching processing_batch transfer row.
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

  -- 7c. Never guess the restore destination.
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

  -- 10. Write the undo transfer with server-owned actor attribution.
  v_tr_id := 'tr-' || gen_random_uuid()::text;
  INSERT INTO public.cattle_transfers (id, cattle_id, from_herd, to_herd, reason, reference_id, team_member)
    VALUES (v_tr_id, p_cattle_id, 'processed', v_prior, 'processing_batch_undo', p_batch_id, v_actor_name);

  -- 11. Clear matching weigh-ins (link + processor flag) and collect ids.
  WITH cleared AS (
    UPDATE public.weigh_ins
      SET target_processing_batch_id = NULL,
          send_to_processor = false
      WHERE target_processing_batch_id = p_batch_id
        AND tag = COALESCE(v_tag, '')
      RETURNING id
  )
  SELECT COALESCE(jsonb_agg(id), '[]'::jsonb) INTO v_cleared FROM cleared;

  -- 12. Write one Activity event in the same transaction.
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
      'team_member', v_actor_name
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

COMMENT ON FUNCTION public.detach_cattle_from_processing_batch(text, text, text) IS
  'Atomically detaches cattle from a processing batch. Admin/management are allowed; farm_team requires cattle program access. p_team_member is compatibility-only and attribution is server-stamped.';

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
  v_caller         uuid := auth.uid();
  v_role           text;
  v_program_access text[];
  v_actor_name     text;
  v_tag            text;
  v_pbid           text;
  v_detail         jsonb;
  v_new_detail     jsonb;
  v_live           numeric;
  v_hang           numeric;
  v_prior          text;
  v_tr_id          text;
  v_ae_id          text;
  v_cleared        jsonb;
  v_label          text;
  v_batch_label    text;
BEGIN
  -- 1. Authenticate and resolve the server-owned caller identity.
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'detach_sheep_from_processing_batch: authenticated caller required';
  END IF;

  SELECT p.role,
         p.program_access,
         COALESCE(NULLIF(btrim(p.full_name), ''), NULLIF(btrim(p.email), ''))
    INTO v_role, v_program_access, v_actor_name
    FROM public.profiles p
    WHERE p.id = v_caller;

  -- 2. Preserve admin/management and admit only program-authorized farm_team.
  IF v_role IS NULL OR v_role NOT IN ('admin', 'management', 'farm_team') THEN
    RAISE EXCEPTION 'detach_sheep_from_processing_batch: caller role % cannot detach', COALESCE(v_role, 'null');
  END IF;
  IF v_role = 'farm_team'
     AND v_program_access IS NOT NULL
     AND array_length(v_program_access, 1) IS NOT NULL
     AND NOT COALESCE('sheep' = ANY(v_program_access), false) THEN
    RAISE EXCEPTION 'detach_sheep_from_processing_batch: sheep program access required';
  END IF;

  -- 3. Validate args after authorization so denied callers cannot probe rows.
  IF p_sheep_id IS NULL OR p_sheep_id = '' OR p_batch_id IS NULL OR p_batch_id = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_args');
  END IF;

  -- 4. Take an unlocked animal snapshot to preserve migration-081's early
  -- no_sheep/not_in_batch results. Membership is revalidated after all locks.
  -- No deleted_at filter preserves migration-081 behavior.
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

  -- 6. Lock in migration-096 order: batch -> weigh-ins -> animal.
  SELECT b.sheep_detail, b.name
    INTO v_detail, v_batch_label
    FROM public.sheep_processing_batches b
    WHERE b.id = p_batch_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_batch', 'tag', v_tag, 'batch_id', p_batch_id);
  END IF;

  PERFORM 1
    FROM public.weigh_ins w
    WHERE w.target_processing_batch_id = p_batch_id
    ORDER BY w.id
    FOR UPDATE;

  SELECT s.tag, s.processing_batch_id
    INTO v_tag, v_pbid
    FROM public.sheep s
    WHERE s.id = p_sheep_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_sheep');
  END IF;
  IF v_pbid IS DISTINCT FROM p_batch_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_in_batch', 'tag', v_tag, 'batch_id', p_batch_id);
  END IF;

  -- 7a. Resolve prior flock from the most recent matching weigh-in.
  SELECT w.prior_herd_or_flock
    INTO v_prior
    FROM public.weigh_ins w
    WHERE w.target_processing_batch_id = p_batch_id
      AND w.tag = COALESCE(v_tag, '')
      AND w.prior_herd_or_flock IS NOT NULL
    ORDER BY w.entered_at DESC NULLS LAST
    LIMIT 1;

  -- 7b. Fall back to the latest matching processing_batch transfer row.
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

  -- 7c. Never guess the restore destination.
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

  -- 10. Write the undo transfer with server-owned actor attribution.
  v_tr_id := 'tr-' || gen_random_uuid()::text;
  INSERT INTO public.sheep_transfers (id, sheep_id, from_flock, to_flock, reason, reference_id, team_member)
    VALUES (v_tr_id, p_sheep_id, 'processed', v_prior, 'processing_batch_undo', p_batch_id, v_actor_name);

  -- 11. Clear matching weigh-ins (link + processor flag) and collect ids.
  WITH cleared AS (
    UPDATE public.weigh_ins
      SET target_processing_batch_id = NULL,
          send_to_processor = false
      WHERE target_processing_batch_id = p_batch_id
        AND tag = COALESCE(v_tag, '')
      RETURNING id
  )
  SELECT COALESCE(jsonb_agg(id), '[]'::jsonb) INTO v_cleared FROM cleared;

  -- 12. Write one Activity event in the same transaction.
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
      'team_member', v_actor_name
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

COMMENT ON FUNCTION public.detach_sheep_from_processing_batch(text, text, text) IS
  'Atomically detaches sheep from a processing batch. Admin/management are allowed; farm_team requires sheep program access. p_team_member is compatibility-only and attribution is server-stamped.';

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- End of 170_processing_detach_farm_team.sql
-- ============================================================================
