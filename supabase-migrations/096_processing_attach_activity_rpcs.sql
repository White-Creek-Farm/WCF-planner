-- ============================================================================
-- 096_processing_attach_activity_rpcs.sql
-- ----------------------------------------------------------------------------
-- Transactional processing-attach RPCs for authenticated cattle/sheep
-- Send-to-Processor flows.
--
-- Migration 081 moved processing DETACH to SECDEF RPCs so batch detail,
-- animal state, transfer audit rows, weigh-in flags, and Activity are atomic.
-- This migration adds the matching ATTACH side for the authenticated
-- weigh-in session record-page flow. The shared modals still keep their legacy
-- helper path for public/non-migrated callers, but the authenticated path opts
-- into these RPCs through src/lib/processingAttachApi.js.
--
-- Permission shape: admin OR management only, enforced inside the RPC. The
-- functions are SECURITY DEFINER to make cross-table writes transactional, not
-- to broaden access.
--
-- Return shape (jsonb):
--   {
--     ok: true,
--     batch: <processing batch row as jsonb>,
--     attached: [{entry_id, animal_id, tag, prior_herd|prior_flock}],
--     skipped: [{entry_id, tag, reason}],
--     event_id
--   }
--
-- Skipped reasons mirror the old client helpers:
--   tagless | no_cow_for_tag | no_sheep_for_tag | already_in_batch
-- ============================================================================

-- ─── cattle ─────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.attach_cattle_to_processing_batch(
  p_session_id       text,
  p_entry_ids        text[],
  p_target_batch_id  text DEFAULT NULL,
  p_batch_name       text DEFAULT NULL,
  p_processing_date  date DEFAULT NULL,
  p_team_member      text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller       uuid := auth.uid();
  v_role         text;
  v_session      record;
  v_batch        record;
  v_batch_id     text;
  v_batch_name   text;
  v_detail       jsonb;
  v_existing_ids text[];
  v_entry        record;
  v_cow          record;
  v_prior        text;
  v_live         numeric;
  v_hang         numeric;
  v_attached     jsonb := '[]'::jsonb;
  v_skipped      jsonb := '[]'::jsonb;
  v_event_id     text;
  v_processing_date date;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'attach_cattle_to_processing_batch: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('admin', 'management') THEN
    RAISE EXCEPTION 'attach_cattle_to_processing_batch: caller role % cannot attach', COALESCE(v_role, 'null');
  END IF;

  IF p_session_id IS NULL OR p_session_id = '' THEN
    RAISE EXCEPTION 'attach_cattle_to_processing_batch: p_session_id required';
  END IF;
  IF p_entry_ids IS NULL OR array_length(p_entry_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'attach_cattle_to_processing_batch: p_entry_ids required';
  END IF;

  SELECT * INTO v_session
    FROM public.weigh_in_sessions
    WHERE id = p_session_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attach_cattle_to_processing_batch: session % not found', p_session_id;
  END IF;
  IF v_session.species IS DISTINCT FROM 'cattle' THEN
    RAISE EXCEPTION 'attach_cattle_to_processing_batch: session % is not cattle', p_session_id;
  END IF;

  v_processing_date := COALESCE(p_processing_date, v_session.date, CURRENT_DATE);

  IF p_target_batch_id IS NOT NULL AND p_target_batch_id <> '' THEN
    SELECT * INTO v_batch
      FROM public.cattle_processing_batches
      WHERE id = p_target_batch_id
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'attach_cattle_to_processing_batch: batch % not found', p_target_batch_id;
    END IF;
    IF v_batch.status IS DISTINCT FROM 'scheduled' AND v_batch.status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'attach_cattle_to_processing_batch: batch % must be scheduled or active', p_target_batch_id;
    END IF;
    v_batch_id := v_batch.id;
    v_batch_name := v_batch.name;
    IF v_batch.status = 'scheduled' THEN
      UPDATE public.cattle_processing_batches
        SET status = 'active',
            actual_process_date = v_processing_date
        WHERE id = v_batch_id
        RETURNING * INTO v_batch;
    END IF;
  ELSE
    IF p_batch_name IS NULL OR length(trim(p_batch_name)) = 0 THEN
      RAISE EXCEPTION 'attach_cattle_to_processing_batch: p_batch_name required when no target batch id';
    END IF;
    v_batch_id := 'cpb-' || gen_random_uuid()::text;
    v_batch_name := trim(p_batch_name);
    INSERT INTO public.cattle_processing_batches (
      id, name, planned_process_date, actual_process_date, processing_cost,
      notes, status, cows_detail, total_live_weight, total_hanging_weight
    ) VALUES (
      v_batch_id, v_batch_name, v_processing_date, v_processing_date, NULL,
      NULL, 'active', '[]'::jsonb, NULL, NULL
    )
    RETURNING * INTO v_batch;
  END IF;

  v_detail := COALESCE(v_batch.cows_detail, '[]'::jsonb);
  SELECT COALESCE(array_agg(elem->>'cattle_id'), ARRAY[]::text[])
    INTO v_existing_ids
    FROM jsonb_array_elements(v_detail) elem
    WHERE elem ? 'cattle_id';

  FOR v_entry IN
    SELECT *
      FROM public.weigh_ins
      WHERE id = ANY(p_entry_ids)
        AND session_id = p_session_id
      ORDER BY entered_at NULLS LAST, id
      FOR UPDATE
  LOOP
    IF v_entry.tag IS NULL OR length(trim(v_entry.tag)) = 0 THEN
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'entry_id', v_entry.id,
        'tag', v_entry.tag,
        'reason', 'tagless'
      ));
      CONTINUE;
    END IF;

    SELECT c.*
      INTO v_cow
      FROM public.cattle c
      WHERE c.deleted_at IS NULL
        AND (
          c.tag = v_entry.tag
          OR EXISTS (
            SELECT 1
              FROM jsonb_array_elements(COALESCE(c.old_tags, '[]'::jsonb)) ot
              WHERE ot->>'tag' = v_entry.tag
                AND COALESCE(ot->>'source', '') <> 'import'
          )
        )
      ORDER BY CASE WHEN c.tag = v_entry.tag THEN 0 ELSE 1 END
      LIMIT 1
      FOR UPDATE;

    IF NOT FOUND THEN
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'entry_id', v_entry.id,
        'tag', v_entry.tag,
        'reason', 'no_cow_for_tag'
      ));
      CONTINUE;
    END IF;

    IF v_cow.id = ANY(v_existing_ids) THEN
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'entry_id', v_entry.id,
        'tag', v_entry.tag,
        'reason', 'already_in_batch'
      ));
      CONTINUE;
    END IF;

    v_detail := v_detail || jsonb_build_array(jsonb_build_object(
      'cattle_id', v_cow.id,
      'tag', COALESCE(v_cow.tag, v_entry.tag),
      'live_weight', NULLIF(v_entry.weight::text, '')::numeric,
      'hanging_weight', NULL
    ));
    v_existing_ids := array_append(v_existing_ids, v_cow.id);
    v_prior := v_cow.herd;

    UPDATE public.weigh_ins
      SET target_processing_batch_id = v_batch_id,
          prior_herd_or_flock = CASE
            WHEN v_cow.herd IS NOT NULL AND v_cow.herd <> 'processed'
              THEN v_cow.herd
            ELSE prior_herd_or_flock
          END
      WHERE id = v_entry.id;

    UPDATE public.cattle
      SET processing_batch_id = v_batch_id,
          herd = 'processed'
      WHERE id = v_cow.id;

    IF v_prior IS NOT NULL AND v_prior <> 'processed' THEN
      INSERT INTO public.cattle_transfers (
        id, cattle_id, from_herd, to_herd, reason, reference_id, team_member
      ) VALUES (
        'tr-' || gen_random_uuid()::text, v_cow.id, v_prior, 'processed',
        'processing_batch', v_batch_id, p_team_member
      );
    END IF;

    v_attached := v_attached || jsonb_build_array(jsonb_build_object(
      'entry_id', v_entry.id,
      'animal_id', v_cow.id,
      'tag', COALESCE(v_cow.tag, v_entry.tag),
      'prior_herd', v_prior
    ));
  END LOOP;

  SELECT SUM(NULLIF(elem->>'live_weight', '')::numeric),
         SUM(NULLIF(elem->>'hanging_weight', '')::numeric)
    INTO v_live, v_hang
    FROM jsonb_array_elements(v_detail) elem;

  UPDATE public.cattle_processing_batches
    SET cows_detail = v_detail,
        total_live_weight    = CASE WHEN COALESCE(v_live, 0) > 0 THEN round(v_live, 1) ELSE NULL END,
        total_hanging_weight = CASE WHEN COALESCE(v_hang, 0) > 0 THEN round(v_hang, 1) ELSE NULL END
    WHERE id = v_batch_id
    RETURNING * INTO v_batch;

  v_event_id := 'ae-' || gen_random_uuid()::text;
  INSERT INTO public.activity_events (
    id, entity_type, entity_id, actor_profile_id, event_type, body, payload
  ) VALUES (
    v_event_id,
    'cattle.processing',
    v_batch_id,
    v_caller,
    'field.updated',
    'Attached ' || jsonb_array_length(v_attached)::text || ' cattle from weigh-in session',
    jsonb_build_object(
      'entity_label', COALESCE(NULLIF(v_batch.name, ''), v_batch_id),
      'field', 'cows_detail',
      'action', 'attach',
      'session_id', p_session_id,
      'attached', v_attached,
      'skipped', v_skipped,
      'team_member', p_team_member
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'batch', to_jsonb(v_batch),
    'attached', v_attached,
    'skipped', v_skipped,
    'event_id', v_event_id
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.attach_cattle_to_processing_batch(text, text[], text, text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attach_cattle_to_processing_batch(text, text[], text, text, date, text) TO authenticated;

-- ─── sheep ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.attach_sheep_to_processing_batch(
  p_session_id      text,
  p_entry_ids       text[],
  p_target_batch_id text DEFAULT NULL,
  p_batch_name      text DEFAULT NULL,
  p_planned_date    date DEFAULT NULL,
  p_team_member     text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller       uuid := auth.uid();
  v_role         text;
  v_session      record;
  v_batch        record;
  v_batch_id     text;
  v_batch_name   text;
  v_detail       jsonb;
  v_existing_ids text[];
  v_entry        record;
  v_sheep        record;
  v_prior        text;
  v_live         numeric;
  v_hang         numeric;
  v_attached     jsonb := '[]'::jsonb;
  v_skipped      jsonb := '[]'::jsonb;
  v_event_id     text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'attach_sheep_to_processing_batch: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('admin', 'management') THEN
    RAISE EXCEPTION 'attach_sheep_to_processing_batch: caller role % cannot attach', COALESCE(v_role, 'null');
  END IF;

  IF p_session_id IS NULL OR p_session_id = '' THEN
    RAISE EXCEPTION 'attach_sheep_to_processing_batch: p_session_id required';
  END IF;
  IF p_entry_ids IS NULL OR array_length(p_entry_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'attach_sheep_to_processing_batch: p_entry_ids required';
  END IF;

  SELECT * INTO v_session
    FROM public.weigh_in_sessions
    WHERE id = p_session_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attach_sheep_to_processing_batch: session % not found', p_session_id;
  END IF;
  IF v_session.species IS DISTINCT FROM 'sheep' THEN
    RAISE EXCEPTION 'attach_sheep_to_processing_batch: session % is not sheep', p_session_id;
  END IF;

  IF p_target_batch_id IS NOT NULL AND p_target_batch_id <> '' THEN
    SELECT * INTO v_batch
      FROM public.sheep_processing_batches
      WHERE id = p_target_batch_id
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'attach_sheep_to_processing_batch: batch % not found', p_target_batch_id;
    END IF;
    IF v_batch.status IS DISTINCT FROM 'planned' THEN
      RAISE EXCEPTION 'attach_sheep_to_processing_batch: batch % must be planned', p_target_batch_id;
    END IF;
    v_batch_id := v_batch.id;
    v_batch_name := v_batch.name;
  ELSE
    IF p_batch_name IS NULL OR length(trim(p_batch_name)) = 0 THEN
      RAISE EXCEPTION 'attach_sheep_to_processing_batch: p_batch_name required when no target batch id';
    END IF;
    v_batch_id := 'spb-' || gen_random_uuid()::text;
    v_batch_name := trim(p_batch_name);
    INSERT INTO public.sheep_processing_batches (
      id, name, planned_process_date, actual_process_date, processing_cost,
      notes, status, sheep_detail, total_live_weight, total_hanging_weight
    ) VALUES (
      v_batch_id, v_batch_name, p_planned_date, NULL, NULL,
      NULL, 'planned', '[]'::jsonb, NULL, NULL
    )
    RETURNING * INTO v_batch;
  END IF;

  v_detail := COALESCE(v_batch.sheep_detail, '[]'::jsonb);
  SELECT COALESCE(array_agg(elem->>'sheep_id'), ARRAY[]::text[])
    INTO v_existing_ids
    FROM jsonb_array_elements(v_detail) elem
    WHERE elem ? 'sheep_id';

  FOR v_entry IN
    SELECT *
      FROM public.weigh_ins
      WHERE id = ANY(p_entry_ids)
        AND session_id = p_session_id
      ORDER BY entered_at NULLS LAST, id
      FOR UPDATE
  LOOP
    IF v_entry.tag IS NULL OR length(trim(v_entry.tag)) = 0 THEN
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'entry_id', v_entry.id,
        'tag', v_entry.tag,
        'reason', 'tagless'
      ));
      CONTINUE;
    END IF;

    SELECT s.*
      INTO v_sheep
      FROM public.sheep s
      WHERE s.deleted_at IS NULL
        AND (
          s.tag = v_entry.tag
          OR EXISTS (
            SELECT 1
              FROM jsonb_array_elements(COALESCE(s.old_tags, '[]'::jsonb)) ot
              WHERE ot->>'tag' = v_entry.tag
                AND COALESCE(ot->>'source', '') <> 'import'
          )
        )
      ORDER BY CASE WHEN s.tag = v_entry.tag THEN 0 ELSE 1 END
      LIMIT 1
      FOR UPDATE;

    IF NOT FOUND THEN
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'entry_id', v_entry.id,
        'tag', v_entry.tag,
        'reason', 'no_sheep_for_tag'
      ));
      CONTINUE;
    END IF;

    IF v_sheep.id = ANY(v_existing_ids) THEN
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'entry_id', v_entry.id,
        'tag', v_entry.tag,
        'reason', 'already_in_batch'
      ));
      CONTINUE;
    END IF;

    v_detail := v_detail || jsonb_build_array(jsonb_build_object(
      'sheep_id', v_sheep.id,
      'tag', COALESCE(v_sheep.tag, v_entry.tag),
      'live_weight', NULLIF(v_entry.weight::text, '')::numeric,
      'hanging_weight', NULL
    ));
    v_existing_ids := array_append(v_existing_ids, v_sheep.id);
    v_prior := v_sheep.flock;

    UPDATE public.weigh_ins
      SET target_processing_batch_id = v_batch_id,
          prior_herd_or_flock = CASE
            WHEN v_sheep.flock IS NOT NULL AND v_sheep.flock <> 'processed'
              THEN v_sheep.flock
            ELSE prior_herd_or_flock
          END
      WHERE id = v_entry.id;

    UPDATE public.sheep
      SET processing_batch_id = v_batch_id,
          flock = 'processed'
      WHERE id = v_sheep.id;

    IF v_prior IS NOT NULL AND v_prior <> 'processed' THEN
      INSERT INTO public.sheep_transfers (
        id, sheep_id, from_flock, to_flock, reason, reference_id, team_member
      ) VALUES (
        'tr-' || gen_random_uuid()::text, v_sheep.id, v_prior, 'processed',
        'processing_batch', v_batch_id, p_team_member
      );
    END IF;

    v_attached := v_attached || jsonb_build_array(jsonb_build_object(
      'entry_id', v_entry.id,
      'animal_id', v_sheep.id,
      'tag', COALESCE(v_sheep.tag, v_entry.tag),
      'prior_flock', v_prior
    ));
  END LOOP;

  SELECT SUM(NULLIF(elem->>'live_weight', '')::numeric),
         SUM(NULLIF(elem->>'hanging_weight', '')::numeric)
    INTO v_live, v_hang
    FROM jsonb_array_elements(v_detail) elem;

  UPDATE public.sheep_processing_batches
    SET sheep_detail = v_detail,
        total_live_weight    = CASE WHEN COALESCE(v_live, 0) > 0 THEN round(v_live, 1) ELSE NULL END,
        total_hanging_weight = CASE WHEN COALESCE(v_hang, 0) > 0 THEN round(v_hang, 1) ELSE NULL END
    WHERE id = v_batch_id
    RETURNING * INTO v_batch;

  v_event_id := 'ae-' || gen_random_uuid()::text;
  INSERT INTO public.activity_events (
    id, entity_type, entity_id, actor_profile_id, event_type, body, payload
  ) VALUES (
    v_event_id,
    'sheep.processing',
    v_batch_id,
    v_caller,
    'field.updated',
    'Attached ' || jsonb_array_length(v_attached)::text || ' sheep from weigh-in session',
    jsonb_build_object(
      'entity_label', COALESCE(NULLIF(v_batch.name, ''), v_batch_id),
      'field', 'sheep_detail',
      'action', 'attach',
      'session_id', p_session_id,
      'attached', v_attached,
      'skipped', v_skipped,
      'team_member', p_team_member
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'batch', to_jsonb(v_batch),
    'attached', v_attached,
    'skipped', v_skipped,
    'event_id', v_event_id
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.attach_sheep_to_processing_batch(text, text[], text, text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attach_sheep_to_processing_batch(text, text[], text, text, date, text) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- End of 096_processing_attach_activity_rpcs.sql
-- ============================================================================
