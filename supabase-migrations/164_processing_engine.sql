-- ============================================================================
-- 164_processing_engine.sql
-- ----------------------------------------------------------------------------
-- Processing "engine" lane: native record workflow completeness on top of
-- migrations 156-163. Everything here is Processing-domain only; no source
-- (cattle/sheep/app_store) table writes.
--
-- 1. Schema deltas:
--    • processing_records: + assignee_profile_id (uuid), + assignee_name (text —
--      imported Asana display-name fallback until a profile is assigned).
--    • processing_subtasks: + assignee_profile_id (uuid) alongside the imported
--      text assignee.
--    • processing_asana_sync_settings: + last_planner_reconcile_at (freshness
--      stamp for the automatic planner reconcile).
-- 2. _processing_emit_activity(...) — best-effort internal Activity emitter for
--    the operational RPCs (same pattern as mig 157's subtask toggle emit; never
--    blocks the mutation).
-- 3. set_processing_field(p_id, p_field_id, p_value) — typed local custom-field
--    values stored in processing_records.fields keyed by STABLE template field
--    id. Refuses milestones and the RESERVED bound ids (Planner-owned facts,
--    derived formulas, and RPC-owned processor/customer — see
--    src/lib/processingFields.js; keep both lists in lockstep). Values are
--    validated against the ACTIVE template field type.
-- 4. set_processing_assignee(p_id, p_profile_id) — parent record assignee
--    (profile-backed; NULL clears; clears the imported display-name fallback).
-- 5. Milestone RPCs reissued with assignee + canonical status + explicit
--    date-clear (old signatures DROPPED; params-with-defaults would otherwise
--    create ambiguous overloads).
-- 6. Subtask RPCs reissued with profile-backed assignee + Activity emits, plus
--    reorder_processing_subtasks(p_record_id, p_ids[]).
-- 7. Processor / customer / complete / reopen / apply-template reissued with
--    Activity emits (audit trail for every Processing-owned mutation).
-- 8. upsert_processing_from_planner INSERT branch auto-seeds the active
--    template checklist EXACTLY ONCE onto newly-minted planner_batch rows
--    (idempotent: only the insert branch seeds; re-runs hit the update branch).
-- 9. reconcile_planner_to_processing reissued: operational-role gate (freshness
--    must not depend on an admin), + stamps last_planner_reconcile_at.
-- 10. ensure_processing_freshness(p_max_age_seconds) — the automatic freshness
--     entry point the /processing page calls on load: staleness-stamped,
--     advisory-try-locked (skips when a reconcile is already running), never
--     calls Asana.
-- 11. list_processing_records / get_processing_record reissued: rows also carry
--     assignee_profile_id / assignee_name and (broiler planner rows) a derived
--     farm_arrival (= ppp-v4 hatch date; day-old chicks arrive at hatch).
--
-- Error class: deterministic failures use 'PROCESSING_VALIDATION:'.
-- NO BEGIN/COMMIT (TEST applies via exec_sql; PROD via psql --single-transaction).
-- Apply order: TEST first, PROD after lane approval.
-- Depends on: 156 (domain), 157 (reconciler), 160 (TOF read shape), 162 (options).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── 1. Schema deltas ─────────────────────────────────────────────────────────
ALTER TABLE public.processing_records
  ADD COLUMN IF NOT EXISTS assignee_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assignee_name       text;

ALTER TABLE public.processing_subtasks
  ADD COLUMN IF NOT EXISTS assignee_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.processing_asana_sync_settings
  ADD COLUMN IF NOT EXISTS last_planner_reconcile_at timestamptz;

-- ── 2. Best-effort Activity emitter (internal) ───────────────────────────────
CREATE OR REPLACE FUNCTION public._processing_emit_activity(
  p_record_id text,
  p_event_type text,
  p_body text,
  p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
BEGIN
  INSERT INTO public.activity_events (id, entity_type, entity_id, actor_profile_id, event_type, body, payload)
  VALUES ('ae-' || gen_random_uuid()::text, 'processing.record', p_record_id, auth.uid(),
          COALESCE(p_event_type, 'field.updated'), p_body, COALESCE(p_payload, '{}'::jsonb));
EXCEPTION WHEN OTHERS THEN
  NULL; -- best-effort: an Activity failure never blocks the mutation
END
$fn$;
REVOKE ALL ON FUNCTION public._processing_emit_activity(text, text, text, jsonb) FROM PUBLIC, anon, authenticated;

-- ── 3. Typed local custom-field values ───────────────────────────────────────
-- Reserved BOUND ids: Planner-owned facts, derived formulas, and RPC-owned
-- processor/customer. Mirrors RESERVED_PROCESSING_FIELD_IDS in
-- src/lib/processingFields.js — keep in lockstep.
CREATE OR REPLACE FUNCTION public._processing_reserved_field_ids()
RETURNS text[]
LANGUAGE sql IMMUTABLE
AS $$
  SELECT ARRAY['procActual','procPlanned','status','program','batchName','animals','year',
               'actualTOF','plannedTOF','timeRemaining','customer','processor']
$$;
REVOKE ALL ON FUNCTION public._processing_reserved_field_ids() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_processing_field(
  p_id       text,
  p_field_id text,
  p_value    jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_rec    public.processing_records;
  v_tpl    public.processing_templates;
  v_def    jsonb;
  v_type   text;
  v_name   text;
  v_next   jsonb;
  v_elem   jsonb;
BEGIN
  PERFORM public._processing_require_operational();
  SELECT * INTO v_rec FROM public.processing_records WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROCESSING_VALIDATION: record not found'; END IF;
  IF v_rec.record_type = 'milestone' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: milestones do not take template fields';
  END IF;
  IF p_field_id IS NULL OR p_field_id !~ '^[A-Za-z0-9_-]{1,60}$' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: invalid field id';
  END IF;
  IF p_field_id = ANY (public._processing_reserved_field_ids()) THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: field % is source-owned or derived and cannot be edited here', p_field_id;
  END IF;

  -- The field must exist on the ACTIVE template for this record's program, and
  -- the value must match its declared type (typed values, server-enforced).
  SELECT * INTO v_tpl FROM public.processing_templates
   WHERE program = v_rec.program AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: no active template for program %', v_rec.program;
  END IF;
  SELECT f INTO v_def
    FROM jsonb_array_elements(COALESCE(v_tpl.fields, '[]'::jsonb)) AS f
   WHERE f->>'id' = p_field_id
   LIMIT 1;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: field % is not on the active % template', p_field_id, v_rec.program;
  END IF;
  v_type := COALESCE(v_def->>'type', 'text');
  v_name := COALESCE(v_def->>'name', p_field_id);
  IF v_type = 'formula' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: formula fields are derived and read-only';
  END IF;

  -- NULL clears the stored value; otherwise validate by type.
  IF p_value IS NOT NULL AND jsonb_typeof(p_value) <> 'null' THEN
    IF length(p_value::text) > 4000 THEN
      RAISE EXCEPTION 'PROCESSING_VALIDATION: field value too large';
    END IF;
    IF v_type = 'number' THEN
      IF jsonb_typeof(p_value) <> 'number' THEN
        RAISE EXCEPTION 'PROCESSING_VALIDATION: % expects a number', v_name;
      END IF;
    ELSIF v_type = 'date' THEN
      IF jsonb_typeof(p_value) <> 'string' OR (p_value #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$' THEN
        RAISE EXCEPTION 'PROCESSING_VALIDATION: % expects a YYYY-MM-DD date', v_name;
      END IF;
    ELSIF v_type = 'multi' THEN
      IF jsonb_typeof(p_value) <> 'array' THEN
        RAISE EXCEPTION 'PROCESSING_VALIDATION: % expects a list', v_name;
      END IF;
      FOR v_elem IN SELECT e FROM jsonb_array_elements(p_value) AS e LOOP
        IF jsonb_typeof(v_elem) <> 'string' THEN
          RAISE EXCEPTION 'PROCESSING_VALIDATION: % expects a list of text values', v_name;
        END IF;
      END LOOP;
    ELSIF v_type IN ('text', 'single', 'people') THEN
      IF jsonb_typeof(p_value) <> 'string' THEN
        RAISE EXCEPTION 'PROCESSING_VALIDATION: % expects a text value', v_name;
      END IF;
    ELSE
      RAISE EXCEPTION 'PROCESSING_VALIDATION: unknown field type %', v_type;
    END IF;
  END IF;

  IF p_value IS NULL OR jsonb_typeof(p_value) = 'null' THEN
    v_next := COALESCE(v_rec.fields, '{}'::jsonb) - p_field_id;
  ELSE
    v_next := COALESCE(v_rec.fields, '{}'::jsonb) || jsonb_build_object(p_field_id, p_value);
  END IF;

  UPDATE public.processing_records
     SET fields = v_next, updated_at = now()
   WHERE id = p_id;

  PERFORM public._processing_emit_activity(
    p_id, 'field.updated',
    'Updated field: ' || v_name,
    jsonb_build_object('action', 'set_field', 'field_id', p_field_id, 'field_name', v_name));

  RETURN jsonb_build_object('id', p_id, 'ok', true, 'field_id', p_field_id);
END
$fn$;
REVOKE ALL ON FUNCTION public.set_processing_field(text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_processing_field(text, text, jsonb) TO authenticated;

-- ── 4. Parent record assignee (profile-backed) ───────────────────────────────
CREATE OR REPLACE FUNCTION public.set_processing_assignee(p_id text, p_profile_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_name text;
BEGIN
  PERFORM public._processing_require_operational();
  IF NOT EXISTS (SELECT 1 FROM public.processing_records WHERE id = p_id) THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: record not found';
  END IF;
  IF p_profile_id IS NOT NULL THEN
    SELECT full_name INTO v_name FROM public.profiles WHERE id = p_profile_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PROCESSING_VALIDATION: assignee profile not found';
    END IF;
  END IF;
  -- Assigning a real profile (or clearing) supersedes the imported display-name
  -- fallback; the imported name remains in the raw snapshot for provenance.
  UPDATE public.processing_records
     SET assignee_profile_id = p_profile_id,
         assignee_name = NULL,
         updated_at = now()
   WHERE id = p_id;
  PERFORM public._processing_emit_activity(
    p_id, 'field.updated',
    CASE WHEN p_profile_id IS NULL THEN 'Cleared assignee' ELSE 'Assigned to ' || COALESCE(v_name, 'user') END,
    jsonb_build_object('action', 'set_assignee', 'assignee_profile_id', p_profile_id));
  RETURN jsonb_build_object('id', p_id, 'ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.set_processing_assignee(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_processing_assignee(text, uuid) TO authenticated;

-- ── 5. Milestones: assignee + canonical status + explicit date clear ─────────
-- Old signatures are dropped: adding defaulted params to the same name would
-- leave TWO overloads and PostgREST could no longer resolve the call.
DROP FUNCTION IF EXISTS public.create_processing_milestone(text, text, text, date, text, jsonb);

CREATE OR REPLACE FUNCTION public.create_processing_milestone(
  p_id                  text,
  p_program             text,
  p_title               text,
  p_processing_date     date DEFAULT NULL,
  p_processor           text DEFAULT NULL,
  p_customer            jsonb DEFAULT '[]'::jsonb,
  p_status              text DEFAULT 'planned',
  p_assignee_profile_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_caller uuid := auth.uid(); v_status text := lower(COALESCE(p_status, 'planned'));
BEGIN
  PERFORM public._processing_require_operational();
  IF EXISTS (SELECT 1 FROM public.processing_records WHERE id = p_id) THEN
    RETURN jsonb_build_object('id', p_id, 'replayed', true);
  END IF;
  IF p_id IS NULL OR p_id !~ '^[A-Za-z0-9-]+$' OR length(p_id) > 100 THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: invalid milestone id';
  END IF;
  IF p_program NOT IN ('broiler','cattle','pig','sheep') THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: invalid program %', COALESCE(p_program,'null');
  END IF;
  IF p_title IS NULL OR length(btrim(p_title)) < 1 THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: milestone title is required';
  END IF;
  IF v_status NOT IN ('planned','in_process','complete') THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: invalid status % (planned | in_process | complete)', p_status;
  END IF;
  IF p_assignee_profile_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_assignee_profile_id) THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: assignee profile not found';
  END IF;
  INSERT INTO public.processing_records
    (id, record_type, program, title, processing_date, status, completed_at, processor, customer,
     assignee_profile_id, match_status, created_by)
  VALUES
    (p_id, 'milestone', p_program, btrim(p_title), p_processing_date, v_status,
     CASE WHEN v_status = 'complete' THEN now() ELSE NULL END,
     p_processor, COALESCE(p_customer, '[]'::jsonb), p_assignee_profile_id, 'native', v_caller);
  PERFORM public._processing_emit_activity(
    p_id, 'record.created', 'Created milestone: ' || btrim(p_title),
    jsonb_build_object('action', 'create_milestone', 'program', p_program));
  RETURN jsonb_build_object('id', p_id, 'replayed', false);
END
$fn$;
REVOKE ALL ON FUNCTION public.create_processing_milestone(text, text, text, date, text, jsonb, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_processing_milestone(text, text, text, date, text, jsonb, text, uuid) TO authenticated;

DROP FUNCTION IF EXISTS public.update_processing_milestone(text, text, date, text, text, jsonb);

CREATE OR REPLACE FUNCTION public.update_processing_milestone(
  p_id                  text,
  p_title               text DEFAULT NULL,
  p_processing_date     date DEFAULT NULL,
  p_status              text DEFAULT NULL,
  p_processor           text DEFAULT NULL,
  p_customer            jsonb DEFAULT NULL,
  p_assignee_profile_id uuid DEFAULT NULL,
  p_clear_assignee      boolean DEFAULT false,
  p_clear_date          boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_rec    public.processing_records;
  v_status text;
  v_changed text[] := ARRAY[]::text[];
BEGIN
  PERFORM public._processing_require_operational();
  SELECT * INTO v_rec FROM public.processing_records WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROCESSING_VALIDATION: record not found'; END IF;
  IF v_rec.record_type <> 'milestone' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: only milestones are editable this way';
  END IF;
  IF p_status IS NOT NULL THEN
    v_status := lower(p_status);
    IF v_status NOT IN ('planned','in_process','complete') THEN
      RAISE EXCEPTION 'PROCESSING_VALIDATION: invalid status % (planned | in_process | complete)', p_status;
    END IF;
  END IF;
  IF p_assignee_profile_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_assignee_profile_id) THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: assignee profile not found';
  END IF;

  IF NULLIF(btrim(COALESCE(p_title, '')), '') IS NOT NULL AND btrim(p_title) <> v_rec.title THEN
    v_changed := array_append(v_changed, 'name');
  END IF;
  IF p_clear_date OR (p_processing_date IS NOT NULL AND p_processing_date IS DISTINCT FROM v_rec.processing_date) THEN
    v_changed := array_append(v_changed, 'date');
  END IF;
  IF v_status IS NOT NULL AND v_status IS DISTINCT FROM v_rec.status THEN
    v_changed := array_append(v_changed, 'status');
  END IF;
  IF p_processor IS NOT NULL THEN v_changed := array_append(v_changed, 'processor'); END IF;
  IF p_customer IS NOT NULL THEN v_changed := array_append(v_changed, 'customer'); END IF;
  IF p_clear_assignee OR p_assignee_profile_id IS NOT NULL THEN
    v_changed := array_append(v_changed, 'assignee');
  END IF;

  UPDATE public.processing_records SET
    title           = COALESCE(NULLIF(btrim(p_title), ''), title),
    -- Explicit clear beats COALESCE-keep: a milestone date may be intentionally
    -- removed (a floating planning marker).
    processing_date = CASE WHEN p_clear_date THEN NULL
                           ELSE COALESCE(p_processing_date, processing_date) END,
    status          = COALESCE(v_status, status),
    completed_at    = CASE WHEN v_status = 'complete' THEN COALESCE(completed_at, now())
                           WHEN v_status IS NOT NULL THEN NULL
                           ELSE completed_at END,
    processor       = COALESCE(p_processor, processor),
    customer        = COALESCE(p_customer, customer),
    assignee_profile_id = CASE WHEN p_clear_assignee THEN NULL
                               ELSE COALESCE(p_assignee_profile_id, assignee_profile_id) END,
    assignee_name   = CASE WHEN p_clear_assignee OR p_assignee_profile_id IS NOT NULL THEN NULL
                           ELSE assignee_name END,
    updated_at      = now()
  WHERE id = p_id;

  IF array_length(v_changed, 1) IS NOT NULL THEN
    PERFORM public._processing_emit_activity(
      p_id, 'field.updated', 'Updated milestone (' || array_to_string(v_changed, ', ') || ')',
      jsonb_build_object('action', 'update_milestone', 'changed', to_jsonb(v_changed)));
  END IF;
  RETURN jsonb_build_object('id', p_id, 'ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.update_processing_milestone(text, text, date, text, text, jsonb, uuid, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_processing_milestone(text, text, date, text, text, jsonb, uuid, boolean, boolean) TO authenticated;

-- ── 6. Subtasks: profile-backed assignee + ordering + Activity ───────────────
DROP FUNCTION IF EXISTS public.add_processing_subtask(text, text, text, text);

CREATE OR REPLACE FUNCTION public.add_processing_subtask(
  p_id                  text,
  p_record_id           text,
  p_label               text,
  p_assignee            text DEFAULT NULL,
  p_assignee_profile_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_caller uuid := auth.uid(); v_next int;
BEGIN
  PERFORM public._processing_require_operational();
  IF EXISTS (SELECT 1 FROM public.processing_subtasks WHERE id = p_id) THEN
    RETURN jsonb_build_object('id', p_id, 'replayed', true);
  END IF;
  IF p_id IS NULL OR p_id !~ '^[A-Za-z0-9-]+$' OR length(p_id) > 100 THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: invalid subtask id';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.processing_records WHERE id = p_record_id) THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: parent record not found';
  END IF;
  IF p_label IS NULL OR length(btrim(p_label)) < 1 THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: subtask label is required';
  END IF;
  IF p_assignee_profile_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_assignee_profile_id) THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: assignee profile not found';
  END IF;
  SELECT COALESCE(max(sort_order), 0) + 1 INTO v_next
    FROM public.processing_subtasks WHERE record_id = p_record_id;
  INSERT INTO public.processing_subtasks
    (id, record_id, label, assignee, assignee_profile_id, sort_order, created_by)
  VALUES (p_id, p_record_id, btrim(p_label), p_assignee, p_assignee_profile_id, v_next, v_caller);
  PERFORM public._processing_emit_activity(
    p_record_id, 'field.updated', 'Added subtask: ' || btrim(p_label),
    jsonb_build_object('action', 'add_subtask', 'subtask_id', p_id));
  RETURN jsonb_build_object('id', p_id, 'replayed', false);
END
$fn$;
REVOKE ALL ON FUNCTION public.add_processing_subtask(text, text, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_processing_subtask(text, text, text, text, uuid) TO authenticated;

DROP FUNCTION IF EXISTS public.update_processing_subtask(text, text, text);

CREATE OR REPLACE FUNCTION public.update_processing_subtask(
  p_id                  text,
  p_label               text DEFAULT NULL,
  p_assignee            text DEFAULT NULL,
  p_assignee_profile_id uuid DEFAULT NULL,
  p_clear_assignee      boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_sub record; v_changed text[] := ARRAY[]::text[];
BEGIN
  PERFORM public._processing_require_operational();
  SELECT id, record_id, label INTO v_sub FROM public.processing_subtasks WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: subtask not found';
  END IF;
  IF p_assignee_profile_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_assignee_profile_id) THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: assignee profile not found';
  END IF;
  IF NULLIF(btrim(COALESCE(p_label, '')), '') IS NOT NULL THEN v_changed := array_append(v_changed, 'label'); END IF;
  IF p_clear_assignee OR p_assignee_profile_id IS NOT NULL OR p_assignee IS NOT NULL THEN
    v_changed := array_append(v_changed, 'assignee');
  END IF;
  UPDATE public.processing_subtasks SET
    label    = COALESCE(NULLIF(btrim(p_label), ''), label),
    -- Explicit clear (p_clear_assignee) removes BOTH the profile-backed and the
    -- imported text assignee; otherwise a provided value wins and the other
    -- representation is cleared so the subtask has ONE current assignee.
    assignee_profile_id = CASE WHEN p_clear_assignee THEN NULL
                               WHEN p_assignee_profile_id IS NOT NULL THEN p_assignee_profile_id
                               WHEN p_assignee IS NOT NULL THEN NULL
                               ELSE assignee_profile_id END,
    assignee = CASE WHEN p_clear_assignee THEN NULL
                    WHEN p_assignee_profile_id IS NOT NULL THEN NULL
                    WHEN p_assignee IS NOT NULL THEN NULLIF(btrim(p_assignee), '')
                    ELSE assignee END,
    updated_at = now()
  WHERE id = p_id;
  IF array_length(v_changed, 1) IS NOT NULL THEN
    PERFORM public._processing_emit_activity(
      v_sub.record_id, 'field.updated',
      'Updated subtask (' || array_to_string(v_changed, ', ') || '): ' || COALESCE(v_sub.label, ''),
      jsonb_build_object('action', 'update_subtask', 'subtask_id', p_id, 'changed', to_jsonb(v_changed)));
  END IF;
  RETURN jsonb_build_object('id', p_id, 'ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.update_processing_subtask(text, text, text, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_processing_subtask(text, text, text, uuid, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_processing_subtask(p_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_sub record;
BEGIN
  PERFORM public._processing_require_operational();
  SELECT id, record_id, label INTO v_sub FROM public.processing_subtasks WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('id', p_id, 'ok', true, 'already_gone', true);
  END IF;
  DELETE FROM public.processing_subtasks WHERE id = p_id;
  PERFORM public._processing_emit_activity(
    v_sub.record_id, 'field.updated', 'Deleted subtask: ' || COALESCE(v_sub.label, ''),
    jsonb_build_object('action', 'delete_subtask', 'subtask_id', p_id));
  RETURN jsonb_build_object('id', p_id, 'ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.delete_processing_subtask(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_processing_subtask(text) TO authenticated;

-- Reorder the record's subtasks to the given id order. Ids not in the list keep
-- their relative order AFTER the listed ones (stable for concurrent adds).
CREATE OR REPLACE FUNCTION public.reorder_processing_subtasks(p_record_id text, p_ids text[])
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_count int; v_max int;
BEGIN
  PERFORM public._processing_require_operational();
  IF NOT EXISTS (SELECT 1 FROM public.processing_records WHERE id = p_record_id) THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: record not found';
  END IF;
  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('id', p_record_id, 'ok', true, 'reordered', 0);
  END IF;
  -- Only this record's subtasks can be positioned by this call.
  UPDATE public.processing_subtasks s
     SET sort_order = ord.pos, updated_at = now()
    FROM (SELECT id, ordinality AS pos FROM unnest(p_ids) WITH ORDINALITY AS t(id, ordinality)) ord
   WHERE s.id = ord.id AND s.record_id = p_record_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  -- Push any unlisted subtasks after the listed block, preserving their order.
  SELECT COALESCE(array_length(p_ids, 1), 0) INTO v_max;
  UPDATE public.processing_subtasks s
     SET sort_order = v_max + ord.pos, updated_at = now()
    FROM (SELECT id, row_number() OVER (ORDER BY sort_order, created_at) AS pos
            FROM public.processing_subtasks
           WHERE record_id = p_record_id AND NOT (id = ANY (p_ids))) ord
   WHERE s.id = ord.id;
  PERFORM public._processing_emit_activity(
    p_record_id, 'field.updated', 'Reordered subtasks',
    jsonb_build_object('action', 'reorder_subtasks', 'count', v_count));
  RETURN jsonb_build_object('id', p_record_id, 'ok', true, 'reordered', v_count);
END
$fn$;
REVOKE ALL ON FUNCTION public.reorder_processing_subtasks(text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reorder_processing_subtasks(text, text[]) TO authenticated;

-- ── 7. Activity emits on the existing Processing-owned mutations ─────────────
CREATE OR REPLACE FUNCTION public.set_processing_processor(p_id text, p_processor text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_old text; v_new text := NULLIF(btrim(COALESCE(p_processor, '')), '');
BEGIN
  PERFORM public._processing_require_operational();
  SELECT processor INTO v_old FROM public.processing_records WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: record not found';
  END IF;
  UPDATE public.processing_records
     SET processor = v_new, updated_at = now()
   WHERE id = p_id;
  IF v_new IS DISTINCT FROM v_old THEN
    PERFORM public._processing_emit_activity(
      p_id, 'field.updated',
      CASE WHEN v_new IS NULL THEN 'Cleared processor' ELSE 'Set processor: ' || v_new END,
      jsonb_build_object('action', 'set_processor'));
  END IF;
  RETURN jsonb_build_object('id', p_id, 'ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.set_processing_processor(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_processing_processor(text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_processing_customer(p_id text, p_customer jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_rec public.processing_records;
BEGIN
  PERFORM public._processing_require_operational();
  SELECT * INTO v_rec FROM public.processing_records WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROCESSING_VALIDATION: record not found'; END IF;
  IF v_rec.program <> 'broiler' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: Customer is a Broiler-only field';
  END IF;
  IF jsonb_typeof(COALESCE(p_customer, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: customer must be a json array';
  END IF;
  UPDATE public.processing_records
     SET customer = COALESCE(p_customer, '[]'::jsonb), updated_at = now()
   WHERE id = p_id;
  IF COALESCE(p_customer, '[]'::jsonb) IS DISTINCT FROM v_rec.customer THEN
    PERFORM public._processing_emit_activity(
      p_id, 'field.updated', 'Updated customer',
      jsonb_build_object('action', 'set_customer', 'customer', COALESCE(p_customer, '[]'::jsonb)));
  END IF;
  RETURN jsonb_build_object('id', p_id, 'ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.set_processing_customer(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_processing_customer(text, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.mark_processing_complete(p_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_blockers text[];
BEGIN
  PERFORM public._processing_require_operational();
  IF NOT EXISTS (SELECT 1 FROM public.processing_records WHERE id = p_id) THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: record not found';
  END IF;
  v_blockers := public._processing_completion_blockers(p_id);
  IF array_length(v_blockers, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: cannot complete — %', array_to_string(v_blockers, '; ');
  END IF;
  UPDATE public.processing_records
     SET status = 'complete', completed_at = now(), updated_at = now()
   WHERE id = p_id;
  PERFORM public._processing_emit_activity(
    p_id, 'status.changed', 'Marked complete',
    jsonb_build_object('action', 'mark_complete'));
  RETURN jsonb_build_object('id', p_id, 'ok', true, 'status', 'complete');
END
$fn$;
REVOKE ALL ON FUNCTION public.mark_processing_complete(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_processing_complete(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.reopen_processing_record(p_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
BEGIN
  PERFORM public._processing_require_operational();
  IF NOT EXISTS (SELECT 1 FROM public.processing_records WHERE id = p_id) THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: record not found';
  END IF;
  UPDATE public.processing_records
     SET status = 'planned', completed_at = NULL, updated_at = now()
   WHERE id = p_id;
  PERFORM public._processing_emit_activity(
    p_id, 'status.changed', 'Reopened',
    jsonb_build_object('action', 'reopen'));
  RETURN jsonb_build_object('id', p_id, 'ok', true, 'status', 'planned');
END
$fn$;
REVOKE ALL ON FUNCTION public.reopen_processing_record(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reopen_processing_record(text) TO authenticated;

-- Apply template stays ADDITIVE and now also seeds each step's profile-backed
-- assignee + emits one summary Activity event.
CREATE OR REPLACE FUNCTION public.apply_current_template(p_record_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_rec    public.processing_records;
  v_tpl    public.processing_templates;
  v_step   jsonb;
  v_added  int := 0;
  v_next   int;
  v_label  text;
  v_pid    uuid;
BEGIN
  PERFORM public._processing_require_operational();
  SELECT * INTO v_rec FROM public.processing_records WHERE id = p_record_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROCESSING_VALIDATION: record not found'; END IF;
  IF v_rec.record_type = 'milestone' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: milestones do not take templates';
  END IF;
  SELECT * INTO v_tpl FROM public.processing_templates
   WHERE program = v_rec.program AND is_active = true;
  IF NOT FOUND THEN RETURN jsonb_build_object('id', p_record_id, 'ok', true, 'added', 0); END IF;
  SELECT COALESCE(max(sort_order), 0) INTO v_next
    FROM public.processing_subtasks WHERE record_id = p_record_id;
  FOR v_step IN SELECT * FROM jsonb_array_elements(v_tpl.checklist)
  LOOP
    v_label := btrim(COALESCE(v_step->>'label', ''));
    CONTINUE WHEN v_label = '';
    IF EXISTS (SELECT 1 FROM public.processing_subtasks
                WHERE record_id = p_record_id AND lower(label) = lower(v_label)) THEN
      CONTINUE;
    END IF;
    v_pid := NULL;
    IF v_step->>'assignee_profile_id' ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'
       AND EXISTS (SELECT 1 FROM public.profiles WHERE id = (v_step->>'assignee_profile_id')::uuid) THEN
      v_pid := (v_step->>'assignee_profile_id')::uuid;
    END IF;
    v_next := v_next + 1;
    INSERT INTO public.processing_subtasks
      (id, record_id, label, assignee, assignee_profile_id, sort_order, created_by)
    VALUES ('pst-' || gen_random_uuid()::text, p_record_id, v_label,
            CASE WHEN v_pid IS NULL THEN v_step->>'assignee' ELSE NULL END, v_pid, v_next, v_caller);
    v_added := v_added + 1;
  END LOOP;
  UPDATE public.processing_records SET template_version = v_tpl.version, updated_at = now()
   WHERE id = p_record_id;
  IF v_added > 0 THEN
    PERFORM public._processing_emit_activity(
      p_record_id, 'field.updated', 'Applied template (' || v_added || ' step(s) added)',
      jsonb_build_object('action', 'apply_template', 'added', v_added, 'template_version', v_tpl.version));
  END IF;
  RETURN jsonb_build_object('id', p_record_id, 'ok', true, 'added', v_added);
END
$fn$;
REVOKE ALL ON FUNCTION public.apply_current_template(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_current_template(text) TO authenticated;

-- ── 8. Planner bridge: auto-seed the checklist on NEW planner rows ───────────
-- Same contract as mig 157 plus: the INSERT branch seeds the active template
-- checklist EXACTLY ONCE (source='native'; a later reconcile hits the UPDATE
-- branch and never re-seeds, so local edits/check-offs/deletes are preserved).
CREATE OR REPLACE FUNCTION public.upsert_processing_from_planner(p_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_kind text := p_row->>'source_kind';
  v_sid  text := p_row->>'source_id';
  v_id   text;
  v_tpl  public.processing_templates;
  v_step jsonb;
  v_label text;
  v_pid  uuid;
  v_next int := 0;
BEGIN
  IF v_kind IS NULL OR v_sid IS NULL OR btrim(v_sid) = '' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: source_kind + source_id required';
  END IF;
  SELECT id INTO v_id FROM public.processing_records WHERE source_kind = v_kind AND source_id = v_sid;
  IF FOUND THEN
    UPDATE public.processing_records SET
      record_type           = 'planner_batch',
      program               = COALESCE(p_row->>'program', program),
      title                 = COALESCE(p_row->>'title', title),
      processing_date       = COALESCE((p_row->>'processing_date')::date, processing_date),
      status                = COALESCE(p_row->>'status', status),
      number_processed      = COALESCE((p_row->>'number_processed')::int, number_processed),
      sub_batch_attribution = COALESCE(p_row->'sub_batch_attribution', sub_batch_attribution),
      match_status          = CASE WHEN match_status = 'native' THEN 'native' ELSE match_status END,
      archived              = false,
      sync_run_id           = COALESCE(p_row->>'sync_run_id', sync_run_id),
      last_synced_at        = now(),
      updated_at            = now()
    WHERE id = v_id;
    RETURN jsonb_build_object('id', v_id, 'action', 'updated');
  END IF;
  v_id := 'prc-' || gen_random_uuid()::text;
  INSERT INTO public.processing_records
    (id, record_type, program, title, processing_date, status, number_processed,
     source_kind, source_id, sub_batch_attribution, match_status, sync_run_id, last_synced_at, created_by)
  VALUES (
    v_id, 'planner_batch', COALESCE(p_row->>'program', 'broiler'),
    COALESCE(p_row->>'title', v_sid), (p_row->>'processing_date')::date,
    COALESCE(p_row->>'status', 'planned'), (p_row->>'number_processed')::int,
    v_kind, v_sid, COALESCE(p_row->'sub_batch_attribution', '[]'::jsonb),
    'native', p_row->>'sync_run_id', now(), public._processing_import_actor()
  );

  -- One-time checklist seed from the ACTIVE template (insert branch only).
  SELECT * INTO v_tpl FROM public.processing_templates
   WHERE program = COALESCE(p_row->>'program', 'broiler') AND is_active = true;
  IF FOUND THEN
    FOR v_step IN SELECT * FROM jsonb_array_elements(COALESCE(v_tpl.checklist, '[]'::jsonb))
    LOOP
      v_label := btrim(COALESCE(v_step->>'label', ''));
      CONTINUE WHEN v_label = '';
      v_pid := NULL;
      IF v_step->>'assignee_profile_id' ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'
         AND EXISTS (SELECT 1 FROM public.profiles WHERE id = (v_step->>'assignee_profile_id')::uuid) THEN
        v_pid := (v_step->>'assignee_profile_id')::uuid;
      END IF;
      v_next := v_next + 1;
      INSERT INTO public.processing_subtasks
        (id, record_id, label, assignee, assignee_profile_id, sort_order, created_by)
      VALUES ('pst-' || gen_random_uuid()::text, v_id, v_label,
              CASE WHEN v_pid IS NULL THEN v_step->>'assignee' ELSE NULL END, v_pid, v_next,
              public._processing_import_actor());
    END LOOP;
    UPDATE public.processing_records SET template_version = v_tpl.version WHERE id = v_id;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'action', 'inserted');
END
$fn$;
REVOKE ALL ON FUNCTION public.upsert_processing_from_planner(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_processing_from_planner(jsonb) TO service_role;

-- ── 9. Reconcile: operational gate + freshness stamp ─────────────────────────
-- Identical enumeration/archival contract to mig 157, with two deltas:
--   • Role gate widens management/admin -> farm_team/management/admin (the
--     automatic freshness path must not depend on a manager being present; the
--     reconcile only mirrors planner facts those roles already control).
--   • Stamps processing_asana_sync_settings.last_planner_reconcile_at so
--     ensure_processing_freshness can debounce.
CREATE OR REPLACE FUNCTION public.reconcile_planner_to_processing()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_role text;
  v_run  text := 'reconcile-' || gen_random_uuid()::text;
  v_cattle int := 0; v_sheep int := 0; v_broiler int := 0; v_pig int := 0;
  v_retired int := 0;
  v_c record; v_s record; v_b jsonb; v_g jsonb; v_t jsonb;
BEGIN
  -- service_role (no auth.uid()) OR any operational role may run it.
  IF auth.uid() IS NOT NULL THEN
    v_role := public.profile_role();
    IF v_role IS NULL OR v_role NOT IN ('farm_team','management','admin') THEN
      RAISE EXCEPTION 'PROCESSING_VALIDATION: caller role % cannot reconcile', COALESCE(v_role,'null');
    END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('processing_reconcile'));

  FOR v_c IN SELECT id, name, status, actual_process_date, planned_process_date, cows_detail
               FROM public.cattle_processing_batches LOOP
    PERFORM public.upsert_processing_from_planner(jsonb_build_object(
      'source_kind','cattle','source_id', v_c.id, 'program','cattle',
      'title', COALESCE(v_c.name, v_c.id),
      'processing_date', COALESCE(v_c.actual_process_date, v_c.planned_process_date),
      'status', v_c.status, 'sync_run_id', v_run,
      'number_processed', jsonb_array_length(COALESCE(v_c.cows_detail, '[]'::jsonb))));
    v_cattle := v_cattle + 1;
  END LOOP;

  FOR v_s IN SELECT id, name, status, actual_process_date, planned_process_date, sheep_detail
               FROM public.sheep_processing_batches LOOP
    PERFORM public.upsert_processing_from_planner(jsonb_build_object(
      'source_kind','sheep','source_id', v_s.id, 'program','sheep',
      'title', COALESCE(v_s.name, v_s.id),
      'processing_date', COALESCE(v_s.actual_process_date, v_s.planned_process_date),
      'status', v_s.status, 'sync_run_id', v_run,
      'number_processed', jsonb_array_length(COALESCE(v_s.sheep_detail, '[]'::jsonb))));
    v_sheep := v_sheep + 1;
  END LOOP;

  FOR v_b IN SELECT value FROM jsonb_array_elements(
               COALESCE((SELECT data::jsonb FROM public.app_store WHERE key = 'ppp-v4'), '[]'::jsonb)) AS t(value) LOOP
    CONTINUE WHEN COALESCE(NULLIF(btrim(COALESCE(v_b->>'processingDate', v_b->>'processing_date', '')), ''), NULL) IS NULL;
    CONTINUE WHEN COALESCE(btrim(COALESCE(v_b->>'name','')), '') = '';
    PERFORM public.upsert_processing_from_planner(jsonb_build_object(
      'source_kind','broiler','source_id', v_b->>'name', 'program','broiler',
      'title', v_b->>'name',
      'processing_date', COALESCE(v_b->>'processingDate', v_b->>'processing_date'),
      'status', COALESCE(v_b->>'status','planned'), 'sync_run_id', v_run,
      'number_processed', COALESCE(v_b->>'totalToProcessor', v_b->>'total_to_processor')));
    v_broiler := v_broiler + 1;
  END LOOP;

  FOR v_g IN SELECT value FROM jsonb_array_elements(
               COALESCE((SELECT data::jsonb FROM public.app_store WHERE key = 'ppp-feeders-v1'), '[]'::jsonb)) AS t(value) LOOP
    FOR v_t IN SELECT value FROM jsonb_array_elements(COALESCE(v_g->'processingTrips', '[]'::jsonb)) AS t(value) LOOP
      CONTINUE WHEN COALESCE(btrim(COALESCE(v_t->>'id','')), '') = '';
      PERFORM public.upsert_processing_from_planner(jsonb_build_object(
        'source_kind','pig',
        'source_id', (v_g->>'id') || ':' || (v_t->>'id'),
        'program','pig',
        'title', COALESCE(v_g->>'batchName', v_g->>'id') || ' — ' || COALESCE(v_t->>'date',''),
        'processing_date', v_t->>'date',
        'status', 'processed', 'sync_run_id', v_run,
        'number_processed', v_t->>'pigCount',
        'sub_batch_attribution', COALESCE(v_t->'subAttributions', '[]'::jsonb)));
      v_pig := v_pig + 1;
    END LOOP;
  END LOOP;

  UPDATE public.processing_records
     SET archived = true, updated_at = now()
   WHERE record_type = 'planner_batch'
     AND archived = false
     AND sync_run_id IS DISTINCT FROM v_run;
  GET DIAGNOSTICS v_retired = ROW_COUNT;

  -- Freshness stamp for ensure_processing_freshness.
  UPDATE public.processing_asana_sync_settings
     SET last_planner_reconcile_at = now(), updated_at = now()
   WHERE id = 'singleton';

  RETURN jsonb_build_object('ok', true, 'cattle', v_cattle, 'sheep', v_sheep,
                            'broiler', v_broiler, 'pig', v_pig, 'retired', v_retired);
END
$fn$;
REVOKE ALL ON FUNCTION public.reconcile_planner_to_processing() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reconcile_planner_to_processing() TO authenticated, service_role;

-- ── 10. Automatic freshness entry point ──────────────────────────────────────
-- The /processing page calls this on load: if the last planner reconcile is
-- older than p_max_age_seconds, run one (advisory-try-locked: when another
-- session is already reconciling, skip instead of queueing). Never touches
-- Asana. Operational roles only.
CREATE OR REPLACE FUNCTION public.ensure_processing_freshness(p_max_age_seconds int DEFAULT 120)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_last timestamptz;
  v_age  int := GREATEST(COALESCE(p_max_age_seconds, 120), 15);
  v_counts jsonb;
BEGIN
  PERFORM public._processing_require_operational();
  SELECT last_planner_reconcile_at INTO v_last
    FROM public.processing_asana_sync_settings WHERE id = 'singleton';
  IF v_last IS NOT NULL AND v_last > now() - make_interval(secs => v_age) THEN
    RETURN jsonb_build_object('ok', true, 'ran', false, 'fresh', true, 'last_reconcile_at', v_last);
  END IF;
  -- Same lock key as the reconcile itself: xact-level advisory locks stack in
  -- one session, so re-acquiring inside reconcile_planner_to_processing is fine;
  -- a CONCURRENT session's reconcile makes this try-lock fail -> skip.
  IF NOT pg_try_advisory_xact_lock(hashtext('processing_reconcile')) THEN
    RETURN jsonb_build_object('ok', true, 'ran', false, 'busy', true);
  END IF;
  v_counts := public.reconcile_planner_to_processing();
  RETURN jsonb_build_object('ok', true, 'ran', true, 'counts', v_counts);
END
$fn$;
REVOKE ALL ON FUNCTION public.ensure_processing_freshness(int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ensure_processing_freshness(int) TO authenticated;

-- ── 11. Read RPCs: assignee + broiler farm-arrival derivation ────────────────
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
  -- Broiler derivation map: whole-day TOF + hatch date (farm arrival for
  -- day-old chicks) per batch name from app_store ppp-v4.
  WITH broiler_src AS (
    SELECT DISTINCT ON (name) name, tof_days, hatch_date FROM (
      SELECT elem->>'name' AS name,
             (left(COALESCE(elem->>'processingDate', elem->>'processing_date'), 10)::date
              - left(COALESCE(elem->>'hatchDate', elem->>'hatch_date'), 10)::date) AS tof_days,
             left(COALESCE(elem->>'hatchDate', elem->>'hatch_date'), 10)::date AS hatch_date
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
      'assignee_profile_id', r.assignee_profile_id, 'assignee_name', r.assignee_name,
      'template_version', r.template_version,
      'subtask_total', COALESCE(st.total, 0), 'subtask_done', COALESCE(st.done, 0),
      'time_on_farm_days', bt.tof_days,
      'farm_arrival', bt.hatch_date
    ) AS row
    FROM public.processing_records r
    LEFT JOIN LATERAL (
      SELECT count(*) AS total, count(*) FILTER (WHERE s.done) AS done
      FROM public.processing_subtasks s WHERE s.record_id = r.id
    ) st ON true
    LEFT JOIN broiler_src bt
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
DECLARE v_rec jsonb; v_subs jsonb; v_atts jsonb; v_blockers text[]; v_tof int; v_hatch date;
BEGIN
  PERFORM public._processing_require_operational();
  SELECT to_jsonb(r) INTO v_rec FROM public.processing_records r WHERE r.id = p_id;
  IF v_rec IS NULL THEN
    RETURN NULL;
  END IF;

  IF (v_rec->>'program') = 'broiler'
     AND (v_rec->>'record_type') = 'planner_batch'
     AND NULLIF(btrim(COALESCE(v_rec->>'source_id', '')), '') IS NOT NULL THEN
    SELECT (left(COALESCE(elem->>'processingDate', elem->>'processing_date'), 10)::date
            - left(COALESCE(elem->>'hatchDate', elem->>'hatch_date'), 10)::date),
           left(COALESCE(elem->>'hatchDate', elem->>'hatch_date'), 10)::date
      INTO v_tof, v_hatch
      FROM jsonb_array_elements(
             COALESCE((SELECT data::jsonb FROM public.app_store WHERE key = 'ppp-v4'), '[]'::jsonb)
           ) AS elem
     WHERE elem->>'name' = (v_rec->>'source_id')
       AND COALESCE(elem->>'processingDate', elem->>'processing_date') ~ '^\d{4}-\d{2}-\d{2}'
       AND COALESCE(elem->>'hatchDate', elem->>'hatch_date') ~ '^\d{4}-\d{2}-\d{2}'
     LIMIT 1;
  END IF;
  v_rec := v_rec || jsonb_build_object('time_on_farm_days', v_tof, 'farm_arrival', v_hatch);

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

-- ============================================================================
-- End of 164_processing_engine.sql
-- ============================================================================
