-- ============================================================================
-- 179_processing_lifecycle_lock_order.sql
-- ----------------------------------------------------------------------------
-- Lock-order hardening for the two migration-100 processing-batch lifecycle
-- RPCs. This closes the follow-up lane that migration 170 explicitly excluded.
--
-- The canonical cattle/sheep processing lifecycle lock order is:
--
--     weigh_in_sessions  ≺  processing batch row  ≺  weigh_ins  ≺  animal rows
--
-- Effective holders of that order before this migration:
--   * attach_cattle_to_processing_batch / attach_sheep_to_processing_batch
--     (migration 096): session -> batch -> weigh-ins -> animal.
--   * detach_cattle_from_processing_batch / detach_sheep_from_processing_batch
--     (migration 170): batch -> weigh-ins -> animal, membership revalidated
--     under the animal lock.
--   * unschedule_cattle_processing_batch / delete_sheep_processing_batch
--     (migration 100): INVERTED. Both loaded the batch row with a plain,
--     unlocked SELECT, then UPDATEd animal rows (acquiring animal row locks),
--     and only acquired the batch row lock at the final DELETE. Against a
--     concurrent attach/detach holding the batch lock and waiting on an animal
--     row, that is a classic AB-BA deadlock. The cattle status gate was also
--     checked before any lock, so an unschedule racing an attach could pass
--     the 'scheduled' check on a stale snapshot and then delete a batch that
--     had just become active with attached cattle.
--
-- This migration reissues ONLY the two migration-100 functions so that they:
--   1. acquire the batch row lock (FOR UPDATE) as their first lock and treat
--      the row version read under that lock as the truth (NOT FOUND ->
--      no_batch; cattle status revalidated under the lock -> not_scheduled);
--   2. lock dependent animal rows deterministically (ORDER BY id FOR UPDATE)
--      before the unlink UPDATE, so multi-row animal locking cannot deadlock
--      against other multi-row lockers;
--   3. keep every other contract identical to migration 100: signatures,
--      jsonb return shapes and reason strings, admin/management-only role
--      gates, SECURITY DEFINER + pinned search_path, Activity semantics
--      (record.deleted BEFORE the row delete, same payload keys), grants, and
--      the straggler-unlink behavior. No lifecycle meaning, permission, or
--      client API changes.
--
-- Neither function touches weigh_ins rows (unchanged from migration 100), so
-- the weigh_ins tier of the canonical order is simply skipped; skipping a tier
-- cannot create an inversion.
--
-- Migration 100 remains read-only history; this is a forward reissue.
-- Apply order: TEST first (this lane), PROD only after explicit approval.
-- ============================================================================

-- ── unschedule_cattle_processing_batch ──────────────────────────────────────

CREATE OR REPLACE FUNCTION public.unschedule_cattle_processing_batch(
  p_batch_id    text,
  p_team_member text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller   uuid := auth.uid();
  v_role     text;
  v_status   text;
  v_name     text;
  v_unlinked int := 0;
  v_ae_id    text;
BEGIN
  -- 1. Authenticate
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'unschedule_cattle_processing_batch: authenticated caller required';
  END IF;

  -- 2. Authorize: admin OR management only (matches page edit rights)
  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('admin', 'management') THEN
    RAISE EXCEPTION 'unschedule_cattle_processing_batch: caller role % cannot unschedule', COALESCE(v_role, 'null');
  END IF;

  -- 3. Validate args
  IF p_batch_id IS NULL OR p_batch_id = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_args');
  END IF;

  -- 4. Lock the batch row FIRST (canonical lifecycle order: batch before
  --    animal rows). FOR UPDATE follows the update chain, so v_status/v_name
  --    are the current committed values, not a stale snapshot.
  SELECT b.status, b.name
    INTO v_status, v_name
    FROM public.cattle_processing_batches b
    WHERE b.id = p_batch_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_batch', 'batch_id', p_batch_id);
  END IF;

  -- 5. Revalidate status UNDER the batch lock. A concurrent attach that
  --    activated this batch now yields not_scheduled instead of a stale
  --    unschedule deleting an active batch.
  IF v_status IS DISTINCT FROM 'scheduled' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_scheduled', 'batch_id', p_batch_id, 'status', v_status);
  END IF;

  -- 6. Deterministically lock any dependent cattle rows (ORDER BY id) before
  --    the unlink UPDATE, then defensively unlink. A scheduled batch is
  --    created empty, so this is normally a 0-row no-op, but never leave a
  --    dangling cattle.processing_batch_id behind.
  PERFORM 1
    FROM public.cattle c
    WHERE c.processing_batch_id = p_batch_id
    ORDER BY c.id
    FOR UPDATE;

  WITH unlinked AS (
    UPDATE public.cattle
      SET processing_batch_id = NULL
      WHERE processing_batch_id = p_batch_id
      RETURNING 1
  )
  SELECT count(*) INTO v_unlinked FROM unlinked;

  -- 7. Audit BEFORE the row is gone (record.deleted on the batch entity).
  v_ae_id := 'ae-' || gen_random_uuid()::text;
  INSERT INTO public.activity_events (
    id, entity_type, entity_id, actor_profile_id, event_type, body, payload
  ) VALUES (
    v_ae_id,
    'cattle.processing',
    p_batch_id,
    v_caller,
    'record.deleted',
    'Unscheduled processing batch ' || COALESCE(NULLIF(v_name, ''), p_batch_id),
    jsonb_build_object(
      'entity_label', COALESCE(NULLIF(v_name, ''), p_batch_id),
      'action', 'unschedule',
      'prior_status', v_status,
      'cattle_unlinked', v_unlinked,
      'team_member', p_team_member
    )
  );

  -- 8. Delete the batch row (same transaction; lock already held).
  DELETE FROM public.cattle_processing_batches WHERE id = p_batch_id;

  RETURN jsonb_build_object(
    'ok', true,
    'reason', 'unscheduled',
    'batch_id', p_batch_id,
    'cattle_unlinked', v_unlinked,
    'event_id', v_ae_id
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.unschedule_cattle_processing_batch(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unschedule_cattle_processing_batch(text, text) TO authenticated;

COMMENT ON FUNCTION public.unschedule_cattle_processing_batch(text, text) IS
  'Atomically deletes an empty scheduled cattle processing batch with audit. Admin/management only. Locks the batch row first (canonical lifecycle lock order), revalidates status under the lock, then deterministically locks and unlinks dependent cattle rows.';

-- ── delete_sheep_processing_batch ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.delete_sheep_processing_batch(
  p_batch_id    text,
  p_team_member text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller   uuid := auth.uid();
  v_role     text;
  v_name     text;
  v_unlinked int := 0;
  v_ae_id    text;
BEGIN
  -- 1. Authenticate
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'delete_sheep_processing_batch: authenticated caller required';
  END IF;

  -- 2. Authorize: admin OR management only (matches page edit rights)
  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('admin', 'management') THEN
    RAISE EXCEPTION 'delete_sheep_processing_batch: caller role % cannot delete', COALESCE(v_role, 'null');
  END IF;

  -- 3. Validate args
  IF p_batch_id IS NULL OR p_batch_id = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_args');
  END IF;

  -- 4. Lock the batch row FIRST (canonical lifecycle order: batch before
  --    animal rows). Migration 100 read this row unlocked and only locked it
  --    at the final DELETE, inverting the attach/detach order.
  SELECT b.name
    INTO v_name
    FROM public.sheep_processing_batches b
    WHERE b.id = p_batch_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_batch', 'batch_id', p_batch_id);
  END IF;

  -- 5. Deterministically lock any sheep still pointing at this batch
  --    (ORDER BY id) before the straggler-clear UPDATE. The page runs the
  --    per-sheep detach RPCs first (flock revert + transfer audit + weigh-in
  --    clear + Activity per animal); this clears the straggler link for sheep
  --    that could not be auto-reverted, so the delete never orphans a
  --    processing_batch_id. Same effect as migration 100, now under the
  --    batch-first lock order.
  PERFORM 1
    FROM public.sheep s
    WHERE s.processing_batch_id = p_batch_id
    ORDER BY s.id
    FOR UPDATE;

  WITH unlinked AS (
    UPDATE public.sheep
      SET processing_batch_id = NULL
      WHERE processing_batch_id = p_batch_id
      RETURNING 1
  )
  SELECT count(*) INTO v_unlinked FROM unlinked;

  -- 6. Audit BEFORE the row is gone (record.deleted on the batch entity).
  v_ae_id := 'ae-' || gen_random_uuid()::text;
  INSERT INTO public.activity_events (
    id, entity_type, entity_id, actor_profile_id, event_type, body, payload
  ) VALUES (
    v_ae_id,
    'sheep.processing',
    p_batch_id,
    v_caller,
    'record.deleted',
    'Deleted processing batch ' || COALESCE(NULLIF(v_name, ''), p_batch_id),
    jsonb_build_object(
      'entity_label', COALESCE(NULLIF(v_name, ''), p_batch_id),
      'action', 'delete',
      'sheep_unlinked', v_unlinked,
      'team_member', p_team_member
    )
  );

  -- 7. Delete the batch row (same transaction; lock already held).
  DELETE FROM public.sheep_processing_batches WHERE id = p_batch_id;

  RETURN jsonb_build_object(
    'ok', true,
    'reason', 'deleted',
    'batch_id', p_batch_id,
    'sheep_unlinked', v_unlinked,
    'event_id', v_ae_id
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.delete_sheep_processing_batch(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_sheep_processing_batch(text, text) TO authenticated;

COMMENT ON FUNCTION public.delete_sheep_processing_batch(text, text) IS
  'Atomically clears straggler sheep links and deletes a sheep processing batch with audit. Admin/management only. Locks the batch row first (canonical lifecycle lock order), then deterministically locks and unlinks dependent sheep rows.';

-- ── Reload PostgREST schema cache ───────────────────────────────────────────

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- End of 179_processing_lifecycle_lock_order.sql
-- ============================================================================
