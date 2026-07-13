-- ============================================================================
-- 177_processing_workflow_integration.sql
-- Processing planner integration — checkpoint 3 of 3 (workflow integration +
-- controlled data correction). Builds on 175 (foundation) and 176 (lifecycle).
--
-- 1. Notifications: adds the 'processing_subtask_assigned' type and a
--    server-side idempotent assignment notifier. New assignment and REAL
--    reassignment notify the assignee; self-assignment, no-op reassignment,
--    replayed calls, and every migration/backfill path stay silent. The
--    notification links the emitted processing.record Activity event so the
--    client can deep-link to the exact record.
-- 2. Assignment scope: Processing subtask assignees must be active users with
--    Processing access (farm_team / management / admin).
-- 3. Templates: upsert_processing_template preserves/mints stable checklist
--    step ids across versions; preview_latest_template diffs the active
--    template against a record's linked subtasks; apply_current_template
--    becomes the idempotent merge-by-step-id (add new non-tombstoned steps,
--    apply renames + current assignments to OPEN linked steps only, never
--    duplicate or reopen completed work, preserve manual steps and
--    removed-template tombstones). delete_processing_subtask tombstones the
--    removed template step so re-apply cannot resurrect it.
-- 4. Due dates: Processing subtasks have no scheduling. Clears every stored
--    due_on/start_on and reissues the Asana subtask importer so future imports
--    ignore those values permanently. No replacement scheduling behavior.
-- 5. Asana record importer: incoming status text is normalized to the
--    Processing vocabulary (planned/in_process/complete) so imports cannot
--    reintroduce raw source statuses after 176's normalization.
-- 6. Profile correction (fail closed): correct_processing_imported_assignee
--    resolves name-only imported assignments to a real profile located by
--    normalized stable email — exactly one active operational profile must
--    match or the call aborts. No UUIDs or emails are hardcoded here; the
--    TEST/PROD apply flow passes the preflight-verified email. The correction
--    is SILENT (no notifications, no activity fan-out) and covers subtasks,
--    record-level imported assignee names, and ACTIVE template checklists;
--    inactive template history stays immutable.
--
-- RLS posture unchanged. All functions SECURITY DEFINER SET search_path =
-- public with narrow grants. NOTIFY pgrst at the end.
-- ============================================================================

-- ── 1. Notification type + assignment notifier ──────────────────────────────
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'task_completed', 'mention', 'comment_mention',
    'todo_completion_approved', 'todo_completion_rejected', 'todo_converted',
    'todo_completion_submitted', 'processing_subtask_assigned'));

-- Activity emit that returns the event id so a notification can deep-link it.
-- Best-effort like _processing_emit_activity: failure returns NULL and never
-- blocks the mutation.
CREATE OR REPLACE FUNCTION public._processing_emit_activity_returning(
  p_record_id text, p_event_type text, p_body text, p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_id text := 'ae-' || gen_random_uuid()::text;
BEGIN
  BEGIN
    INSERT INTO public.activity_events (id, entity_type, entity_id, event_type, actor_profile_id, body, payload)
    VALUES (v_id, 'processing.record', p_record_id, p_event_type, auth.uid(), p_body, COALESCE(p_payload, '{}'::jsonb));
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
  RETURN v_id;
END
$fn$;
REVOKE ALL ON FUNCTION public._processing_emit_activity_returning(text, text, text, jsonb) FROM PUBLIC, anon, authenticated;

-- Assignment eligibility: active users with Processing access only.
CREATE OR REPLACE FUNCTION public._processing_assert_assignable(p_profile_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE
AS $fn$
DECLARE v_role text;
BEGIN
  IF p_profile_id IS NULL THEN RETURN; END IF;
  SELECT role INTO v_role FROM public.profiles WHERE id = p_profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: assignee profile not found';
  END IF;
  IF v_role IS NULL OR v_role NOT IN ('farm_team', 'management', 'admin') THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: assignee must be an active user with Processing access';
  END IF;
END
$fn$;
REVOKE ALL ON FUNCTION public._processing_assert_assignable(uuid) FROM PUBLIC, anon, authenticated;

-- Idempotent assignment notifier. Callers invoke it ONLY on a real assignment
-- change (new profile, different from the previous one); it additionally
-- suppresses self-assignment and missing recipients. The insert is
-- best-effort — a notification failure never rolls back the assignment.
CREATE OR REPLACE FUNCTION public._processing_notify_assignment(
  p_subtask_id text, p_record_id text, p_recipient uuid, p_label text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_title text;
  v_event text;
BEGIN
  IF p_recipient IS NULL OR p_recipient = v_actor THEN RETURN; END IF;
  SELECT title INTO v_title FROM public.processing_records WHERE id = p_record_id;
  v_event := public._processing_emit_activity_returning(
    p_record_id, 'field.updated',
    'Assigned processing work: ' || COALESCE(p_label, ''),
    jsonb_build_object('action', 'assign_subtask', 'subtask_id', p_subtask_id,
                       'assignee_profile_id', p_recipient));
  BEGIN
    INSERT INTO public.notifications
      (id, recipient_profile_id, actor_profile_id, type, title, body, activity_event_id)
    VALUES ('ntf-' || gen_random_uuid()::text, p_recipient, v_actor,
            'processing_subtask_assigned',
            'Processing work assigned',
            left(COALESCE(p_label, '') || CASE WHEN v_title IS NULL THEN '' ELSE ' — ' || v_title END, 200),
            v_event);
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'processing assignment notification failed: %', SQLERRM;
  END;
END
$fn$;
REVOKE ALL ON FUNCTION public._processing_notify_assignment(text, text, uuid, text) FROM PUBLIC, anon, authenticated;

-- ── 2. Subtask RPC reissues (164 base): eligibility + notifications ─────────
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
    -- Replay: no duplicate row, no duplicate notification.
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
  PERFORM public._processing_assert_assignable(p_assignee_profile_id);
  SELECT COALESCE(max(sort_order), 0) + 1 INTO v_next
    FROM public.processing_subtasks WHERE record_id = p_record_id;
  INSERT INTO public.processing_subtasks
    (id, record_id, label, assignee, assignee_profile_id, sort_order, created_by)
  VALUES (p_id, p_record_id, btrim(p_label), p_assignee, p_assignee_profile_id, v_next, v_caller);
  UPDATE public.processing_records SET workflow_touched_at = now() WHERE id = p_record_id;
  PERFORM public._processing_emit_activity(
    p_record_id, 'field.updated', 'Added subtask: ' || btrim(p_label),
    jsonb_build_object('action', 'add_subtask', 'subtask_id', p_id));
  IF p_assignee_profile_id IS NOT NULL THEN
    PERFORM public._processing_notify_assignment(p_id, p_record_id, p_assignee_profile_id, btrim(p_label));
  END IF;
  RETURN jsonb_build_object('id', p_id, 'replayed', false);
END
$fn$;
REVOKE ALL ON FUNCTION public.add_processing_subtask(text, text, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_processing_subtask(text, text, text, text, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.update_processing_subtask(
  p_id                  text,
  p_label               text DEFAULT NULL,
  p_assignee            text DEFAULT NULL,
  p_assignee_profile_id uuid DEFAULT NULL,
  p_clear_assignee      boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_sub record;
  v_changed text[] := ARRAY[]::text[];
  v_new_assignee uuid;
BEGIN
  PERFORM public._processing_require_operational();
  SELECT id, record_id, label, assignee_profile_id INTO v_sub
    FROM public.processing_subtasks WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: subtask not found';
  END IF;
  PERFORM public._processing_assert_assignable(p_assignee_profile_id);
  IF NULLIF(btrim(COALESCE(p_label, '')), '') IS NOT NULL THEN v_changed := array_append(v_changed, 'label'); END IF;
  IF p_clear_assignee OR p_assignee_profile_id IS NOT NULL OR p_assignee IS NOT NULL THEN
    v_changed := array_append(v_changed, 'assignee');
  END IF;
  UPDATE public.processing_subtasks SET
    label    = COALESCE(NULLIF(btrim(p_label), ''), label),
    assignee_profile_id = CASE WHEN p_clear_assignee THEN NULL
                               WHEN p_assignee_profile_id IS NOT NULL THEN p_assignee_profile_id
                               WHEN p_assignee IS NOT NULL THEN NULL
                               ELSE assignee_profile_id END,
    assignee = CASE WHEN p_clear_assignee THEN NULL
                    WHEN p_assignee_profile_id IS NOT NULL THEN NULL
                    WHEN p_assignee IS NOT NULL THEN NULLIF(btrim(p_assignee), '')
                    ELSE assignee END,
    updated_at = now()
  WHERE id = p_id
  RETURNING assignee_profile_id INTO v_new_assignee;
  IF array_length(v_changed, 1) IS NOT NULL THEN
    UPDATE public.processing_records SET workflow_touched_at = now() WHERE id = v_sub.record_id;
    PERFORM public._processing_emit_activity(
      v_sub.record_id, 'field.updated',
      'Updated subtask (' || array_to_string(v_changed, ', ') || '): ' || COALESCE(v_sub.label, ''),
      jsonb_build_object('action', 'update_subtask', 'subtask_id', p_id, 'changed', to_jsonb(v_changed)));
  END IF;
  -- Notify only a REAL reassignment to a new profile (no-op reassignment and
  -- clears stay silent).
  IF v_new_assignee IS NOT NULL AND v_new_assignee IS DISTINCT FROM v_sub.assignee_profile_id THEN
    PERFORM public._processing_notify_assignment(
      p_id, v_sub.record_id, v_new_assignee,
      COALESCE(NULLIF(btrim(COALESCE(p_label, '')), ''), v_sub.label));
  END IF;
  RETURN jsonb_build_object('id', p_id, 'ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.update_processing_subtask(text, text, text, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_processing_subtask(text, text, text, uuid, boolean) TO authenticated;

-- Deleting a template-linked subtask tombstones its step id so "apply latest"
-- can never resurrect it; removing a step is local work (worked-archive rule).
CREATE OR REPLACE FUNCTION public.delete_processing_subtask(p_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_sub record;
BEGIN
  PERFORM public._processing_require_operational();
  SELECT id, record_id, label, template_step_id INTO v_sub
    FROM public.processing_subtasks WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('id', p_id, 'ok', true, 'already_gone', true);
  END IF;
  DELETE FROM public.processing_subtasks WHERE id = p_id;
  UPDATE public.processing_records
     SET workflow_touched_at = now(),
         removed_template_steps = CASE
           WHEN v_sub.template_step_id IS NOT NULL
                AND NOT (removed_template_steps ? v_sub.template_step_id)
           THEN removed_template_steps || jsonb_build_array(to_jsonb(v_sub.template_step_id))
           ELSE removed_template_steps END,
         updated_at = now()
   WHERE id = v_sub.record_id;
  PERFORM public._processing_emit_activity(
    v_sub.record_id, 'field.updated', 'Deleted subtask: ' || COALESCE(v_sub.label, ''),
    jsonb_build_object('action', 'delete_subtask', 'subtask_id', p_id,
                       'template_step_id', v_sub.template_step_id));
  RETURN jsonb_build_object('id', p_id, 'ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.delete_processing_subtask(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_processing_subtask(text) TO authenticated;

-- ── 3. Templates: stable step ids + preview + idempotent merge ──────────────
-- Reissue (156 base): checklist steps carry stable ids across versions. An
-- incoming step keeps its id when it already belongs to this program's
-- template history; steps without an id are minted one. p_fields = NULL keeps
-- the active version's fields (the configurable Fields editor is retired from
-- the product UI; historical fields data is preserved, never wiped).
CREATE OR REPLACE FUNCTION public.upsert_processing_template(
  p_program   text,
  p_fields    jsonb,
  p_checklist jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_caller uuid := auth.uid(); v_role text; v_next int; v_id text;
  v_fields jsonb;
  v_checklist jsonb := '[]'::jsonb;
  v_step jsonb;
  v_sid text;
  v_seen text[] := ARRAY[]::text[];
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'upsert_processing_template: authenticated caller required'; END IF;
  v_role := public.profile_role();
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: caller role % cannot edit templates', COALESCE(v_role,'null');
  END IF;
  IF p_program NOT IN ('broiler','cattle','pig','sheep') THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: invalid program %', COALESCE(p_program,'null');
  END IF;
  IF p_fields IS NOT NULL AND jsonb_typeof(p_fields) <> 'array' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: fields must be a json array';
  END IF;
  IF jsonb_typeof(COALESCE(p_checklist, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: checklist must be a json array';
  END IF;

  -- Fields are retired from the product UI: NULL keeps the active fields.
  IF p_fields IS NULL THEN
    SELECT fields INTO v_fields FROM public.processing_templates
     WHERE program = p_program AND is_active = true;
    v_fields := COALESCE(v_fields, '[]'::jsonb);
  ELSE
    v_fields := p_fields;
  END IF;

  FOR v_step IN SELECT value FROM jsonb_array_elements(COALESCE(p_checklist, '[]'::jsonb)) LOOP
    IF jsonb_typeof(v_step) <> 'object'
       OR COALESCE(btrim(COALESCE(v_step->>'label', '')), '') = '' THEN
      RAISE EXCEPTION 'PROCESSING_VALIDATION: every checklist step needs a label';
    END IF;
    v_sid := NULLIF(btrim(COALESCE(v_step->>'id', '')), '');
    IF v_sid IS NULL THEN
      v_sid := 'stp-' || gen_random_uuid()::text;
    END IF;
    IF v_sid = ANY(v_seen) THEN
      RAISE EXCEPTION 'PROCESSING_VALIDATION: duplicate checklist step id %', v_sid;
    END IF;
    v_seen := array_append(v_seen, v_sid);
    IF v_step->>'assignee_profile_id' IS NOT NULL
       AND v_step->>'assignee_profile_id' ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$' THEN
      PERFORM public._processing_assert_assignable((v_step->>'assignee_profile_id')::uuid);
    END IF;
    v_checklist := v_checklist || jsonb_build_array(v_step || jsonb_build_object('id', v_sid));
  END LOOP;

  SELECT COALESCE(max(version), 0) + 1 INTO v_next FROM public.processing_templates WHERE program = p_program;
  UPDATE public.processing_templates SET is_active = false WHERE program = p_program AND is_active = true;
  v_id := 'ptpl-' || gen_random_uuid()::text;
  INSERT INTO public.processing_templates (id, program, version, fields, checklist, is_active, created_by)
  VALUES (v_id, p_program, v_next, v_fields, v_checklist, true, v_caller);
  RETURN jsonb_build_object('id', v_id, 'program', p_program, 'version', v_next);
END
$fn$;
REVOKE ALL ON FUNCTION public.upsert_processing_template(text, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_processing_template(text, jsonb, jsonb) TO authenticated;

-- Preview what "apply latest template" would do to one record: additions,
-- renames, and assignment changes by stable step id. Read-only.
CREATE OR REPLACE FUNCTION public.preview_latest_template(p_record_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE
AS $fn$
DECLARE
  v_rec public.processing_records;
  v_tpl public.processing_templates;
  v_step jsonb;
  v_sid text;
  v_sub record;
  v_additions jsonb := '[]'::jsonb;
  v_renames jsonb := '[]'::jsonb;
  v_assignments jsonb := '[]'::jsonb;
  v_blocked jsonb := '[]'::jsonb;
  v_step_assignee uuid;
BEGIN
  PERFORM public._processing_require_operational();
  SELECT * INTO v_rec FROM public.processing_records WHERE id = p_record_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROCESSING_VALIDATION: record not found'; END IF;
  IF v_rec.record_type = 'milestone' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: milestones do not take templates';
  END IF;
  SELECT * INTO v_tpl FROM public.processing_templates
   WHERE program = v_rec.program AND is_active = true;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('template_version', NULL, 'additions', '[]'::jsonb,
                              'renames', '[]'::jsonb, 'assignment_changes', '[]'::jsonb,
                              'removed_blocked', '[]'::jsonb, 'up_to_date', true);
  END IF;

  FOR v_step IN SELECT value FROM jsonb_array_elements(COALESCE(v_tpl.checklist, '[]'::jsonb)) LOOP
    v_sid := NULLIF(btrim(COALESCE(v_step->>'id', '')), '');
    CONTINUE WHEN v_sid IS NULL OR COALESCE(btrim(COALESCE(v_step->>'label','')), '') = '';
    IF v_rec.removed_template_steps ? v_sid THEN
      v_blocked := v_blocked || jsonb_build_array(jsonb_build_object(
        'step_id', v_sid, 'label', btrim(v_step->>'label')));
      CONTINUE;
    END IF;
    SELECT id, label, done, assignee_profile_id INTO v_sub
      FROM public.processing_subtasks
     WHERE record_id = p_record_id AND template_step_id = v_sid
     ORDER BY created_at LIMIT 1;
    IF NOT FOUND THEN
      -- Legacy label-linkage (pre-step-id records): treat a same-label
      -- unlinked subtask as this step rather than a new addition.
      SELECT id, label, done, assignee_profile_id INTO v_sub
        FROM public.processing_subtasks
       WHERE record_id = p_record_id AND template_step_id IS NULL
         AND lower(btrim(label)) = lower(btrim(v_step->>'label'))
       ORDER BY created_at LIMIT 1;
      IF NOT FOUND THEN
        v_additions := v_additions || jsonb_build_array(jsonb_build_object(
          'step_id', v_sid, 'label', btrim(v_step->>'label'),
          'assignee_profile_id', v_step->>'assignee_profile_id'));
        CONTINUE;
      END IF;
    END IF;
    IF v_sub.done THEN CONTINUE; END IF;
    IF btrim(COALESCE(v_sub.label, '')) IS DISTINCT FROM btrim(v_step->>'label') THEN
      v_renames := v_renames || jsonb_build_array(jsonb_build_object(
        'subtask_id', v_sub.id, 'from', v_sub.label, 'to', btrim(v_step->>'label')));
    END IF;
    v_step_assignee := NULL;
    IF v_step->>'assignee_profile_id' ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$' THEN
      v_step_assignee := (v_step->>'assignee_profile_id')::uuid;
    END IF;
    IF v_step_assignee IS NOT NULL AND v_step_assignee IS DISTINCT FROM v_sub.assignee_profile_id THEN
      v_assignments := v_assignments || jsonb_build_array(jsonb_build_object(
        'subtask_id', v_sub.id, 'label', COALESCE(btrim(v_step->>'label'), v_sub.label),
        'assignee_profile_id', v_step_assignee));
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'template_version', v_tpl.version,
    'additions', v_additions,
    'renames', v_renames,
    'assignment_changes', v_assignments,
    'removed_blocked', v_blocked,
    'up_to_date', jsonb_array_length(v_additions) = 0
                  AND jsonb_array_length(v_renames) = 0
                  AND jsonb_array_length(v_assignments) = 0);
END
$fn$;
REVOKE ALL ON FUNCTION public.preview_latest_template(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_latest_template(text) TO authenticated;

-- Idempotent merge-by-step-id (replaces the additive label-match apply):
--   • add active steps that are not linked, not label-matched, not tombstoned;
--   • rename + re-assign OPEN linked steps to the template's current label and
--     (when the step names one) assignee — completed steps are never touched
--     or reopened; manual steps and removed-step tombstones are preserved;
--   • adopt legacy label-matched unlinked subtasks by linking their step id;
--   • repeated application is a no-op.
CREATE OR REPLACE FUNCTION public.apply_current_template(p_record_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_rec    public.processing_records;
  v_tpl    public.processing_templates;
  v_step   jsonb;
  v_sid    text;
  v_label  text;
  v_pid    uuid;
  v_sub    record;
  v_added  int := 0;
  v_renamed int := 0;
  v_reassigned int := 0;
  v_adopted int := 0;
  v_next   int;
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

  FOR v_step IN SELECT * FROM jsonb_array_elements(COALESCE(v_tpl.checklist, '[]'::jsonb))
  LOOP
    v_label := btrim(COALESCE(v_step->>'label', ''));
    v_sid := NULLIF(btrim(COALESCE(v_step->>'id', '')), '');
    CONTINUE WHEN v_label = '' OR v_sid IS NULL;
    CONTINUE WHEN v_rec.removed_template_steps ? v_sid;

    v_pid := NULL;
    IF v_step->>'assignee_profile_id' ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'
       AND EXISTS (SELECT 1 FROM public.profiles WHERE id = (v_step->>'assignee_profile_id')::uuid) THEN
      v_pid := (v_step->>'assignee_profile_id')::uuid;
    END IF;

    SELECT id, label, done, assignee_profile_id INTO v_sub
      FROM public.processing_subtasks
     WHERE record_id = p_record_id AND template_step_id = v_sid
     ORDER BY created_at LIMIT 1;
    IF NOT FOUND THEN
      -- Adopt a legacy label-matched unlinked subtask instead of duplicating.
      SELECT id, label, done, assignee_profile_id INTO v_sub
        FROM public.processing_subtasks
       WHERE record_id = p_record_id AND template_step_id IS NULL
         AND lower(btrim(label)) = lower(btrim(v_label))
       ORDER BY created_at LIMIT 1;
      IF FOUND THEN
        UPDATE public.processing_subtasks SET template_step_id = v_sid, updated_at = now()
         WHERE id = v_sub.id;
        v_adopted := v_adopted + 1;
      ELSE
        v_next := v_next + 1;
        INSERT INTO public.processing_subtasks
          (id, record_id, label, assignee, assignee_profile_id, template_step_id, sort_order, created_by)
        VALUES ('pst-' || gen_random_uuid()::text, p_record_id, v_label,
                CASE WHEN v_pid IS NULL THEN v_step->>'assignee' ELSE NULL END, v_pid, v_sid, v_next, v_caller);
        v_added := v_added + 1;
        IF v_pid IS NOT NULL THEN
          PERFORM public._processing_notify_assignment(NULL, p_record_id, v_pid, v_label);
        END IF;
        CONTINUE;
      END IF;
    END IF;

    -- Linked (or just adopted) step: apply rename + current assignment to OPEN
    -- work only. Completed steps are never modified or reopened.
    IF NOT v_sub.done THEN
      IF btrim(COALESCE(v_sub.label, '')) IS DISTINCT FROM v_label THEN
        UPDATE public.processing_subtasks SET label = v_label, updated_at = now() WHERE id = v_sub.id;
        v_renamed := v_renamed + 1;
      END IF;
      IF v_pid IS NOT NULL AND v_pid IS DISTINCT FROM v_sub.assignee_profile_id THEN
        UPDATE public.processing_subtasks
           SET assignee_profile_id = v_pid, assignee = NULL, updated_at = now()
         WHERE id = v_sub.id;
        v_reassigned := v_reassigned + 1;
        PERFORM public._processing_notify_assignment(v_sub.id, p_record_id, v_pid, v_label);
      END IF;
    END IF;
  END LOOP;

  UPDATE public.processing_records SET template_version = v_tpl.version, updated_at = now()
   WHERE id = p_record_id;
  IF v_added + v_renamed + v_reassigned + v_adopted > 0 THEN
    PERFORM public._processing_emit_activity(
      p_record_id, 'field.updated',
      'Applied latest template (' || v_added || ' added, ' || v_renamed || ' renamed, '
        || v_reassigned || ' reassigned)',
      jsonb_build_object('action', 'apply_template', 'added', v_added, 'renamed', v_renamed,
                         'reassigned', v_reassigned, 'adopted', v_adopted,
                         'template_version', v_tpl.version));
  END IF;
  RETURN jsonb_build_object('id', p_record_id, 'ok', true, 'added', v_added,
                            'renamed', v_renamed, 'reassigned', v_reassigned,
                            'adopted', v_adopted, 'template_version', v_tpl.version);
END
$fn$;
REVOKE ALL ON FUNCTION public.apply_current_template(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_current_template(text) TO authenticated;

-- ── 4. Due dates: clear + never reimport ─────────────────────────────────────
UPDATE public.processing_subtasks
   SET due_on = NULL, start_on = NULL, updated_at = now()
 WHERE due_on IS NOT NULL OR start_on IS NOT NULL;

-- Reissue (165 base): identical contract EXCEPT due_on/start_on are ignored on
-- both branches — Processing has no scheduling and imports may not restore it.
CREATE OR REPLACE FUNCTION public.upsert_processing_subtask_from_asana(p_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_gid    text := p_row->>'asana_gid';
  v_rec_id text;
  v_id     text;
  v_exists boolean;
  v_pid    uuid := NULL;
BEGIN
  IF v_gid IS NULL OR btrim(v_gid) = '' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: subtask asana_gid required';
  END IF;
  SELECT processing_record_id INTO v_rec_id
    FROM public.processing_asana_links
   WHERE asana_gid = p_row->>'parent_asana_gid' AND processing_record_id IS NOT NULL;
  IF v_rec_id IS NULL THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: parent record not linked for subtask';
  END IF;
  IF p_row->>'assignee_profile_id' ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'
     AND EXISTS (SELECT 1 FROM public.profiles WHERE id = (p_row->>'assignee_profile_id')::uuid) THEN
    v_pid := (p_row->>'assignee_profile_id')::uuid;
  END IF;
  SELECT id INTO v_id FROM public.processing_subtasks WHERE asana_gid = v_gid;
  v_exists := FOUND;
  IF v_exists THEN
    UPDATE public.processing_subtasks SET
      record_id    = v_rec_id,
      label        = COALESCE(p_row->>'label', label),
      assignee     = CASE WHEN assignee_profile_id IS NOT NULL THEN assignee
                          ELSE COALESCE(p_row->>'assignee', assignee) END,
      assignee_profile_id = CASE WHEN assignee_profile_id IS NOT NULL THEN assignee_profile_id
                                 ELSE COALESCE(v_pid, assignee_profile_id) END,
      done         = CASE WHEN done_locally_set THEN done
                          ELSE COALESCE((p_row->>'done')::boolean, done) END,
      completed_at = CASE WHEN done_locally_set THEN completed_at
                          ELSE COALESCE((p_row->>'completed_at')::timestamptz, completed_at) END,
      -- due_on / start_on intentionally ignored (177): Processing subtasks
      -- have no scheduling, and imports may not restore cleared values.
      sort_order   = COALESCE((p_row->>'sort_order')::int, sort_order),
      updated_at   = now()
    WHERE id = v_id;
    RETURN jsonb_build_object('id', v_id, 'action', 'updated');
  END IF;
  v_id := COALESCE(p_row->>'id', 'pst-' || gen_random_uuid()::text);
  INSERT INTO public.processing_subtasks
    (id, record_id, label, assignee, assignee_profile_id, done, completed_at, asana_gid,
     due_on, start_on, sort_order, source, created_by)
  VALUES (
    v_id, v_rec_id, COALESCE(p_row->>'label', '(untitled)'), p_row->>'assignee', v_pid,
    COALESCE((p_row->>'done')::boolean, false), (p_row->>'completed_at')::timestamptz, v_gid,
    NULL, NULL,
    COALESCE((p_row->>'sort_order')::int, 0), 'asana', public._processing_import_actor()
  );
  RETURN jsonb_build_object('id', v_id, 'action', 'inserted');
END
$fn$;
REVOKE ALL ON FUNCTION public.upsert_processing_subtask_from_asana(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_processing_subtask_from_asana(jsonb) TO service_role;

-- ── 5. Asana record importer: normalize incoming status vocabulary ──────────
-- Reissue (165 base): identical contract EXCEPT the stored status is mapped to
-- planned/in_process/complete (176 normalized existing rows; imports may not
-- reintroduce raw source statuses). Complete rows keep a completed_at stamp so
-- the derived status stays Complete.
CREATE OR REPLACE FUNCTION public.upsert_processing_from_asana(p_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_gid   text := p_row->>'asana_gid';
  v_id    text;
  v_exists boolean;
  v_action text;
  v_type  text := COALESCE(p_row->>'record_type', 'asana_historical');
  v_ms    text;
  v_pid   uuid := NULL;
  v_status text;
BEGIN
  IF v_gid IS NULL OR btrim(v_gid) = '' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: asana_gid required for import';
  END IF;
  IF v_type = 'planner_batch' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: Asana import may not create planner_batch records';
  END IF;
  v_ms := CASE lower(COALESCE(p_row->>'match_status', ''))
            WHEN 'native'       THEN 'native'
            WHEN 'matched'      THEN 'matched'
            WHEN 'review'       THEN 'review'
            WHEN 'needs_review' THEN 'review'
            WHEN ''             THEN NULL
            ELSE 'unmatched'
          END;
  v_status := CASE
                WHEN p_row->>'status' IS NULL THEN NULL
                WHEN lower(btrim(p_row->>'status')) IN ('complete','completed','processed','done') THEN 'complete'
                WHEN lower(btrim(p_row->>'status')) IN ('active','in_process','in-process','in process','processing',
                                                        'in-proccess','in proccess','in_proccess') THEN 'in_process'
                ELSE 'planned'
              END;
  IF p_row->>'assignee_profile_id' ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'
     AND EXISTS (SELECT 1 FROM public.profiles WHERE id = (p_row->>'assignee_profile_id')::uuid) THEN
    v_pid := (p_row->>'assignee_profile_id')::uuid;
  END IF;
  SELECT id INTO v_id FROM public.processing_records WHERE asana_gid = v_gid;
  v_exists := FOUND;
  IF NOT v_exists THEN
    v_id := COALESCE(p_row->>'id', 'prc-' || gen_random_uuid()::text);
  END IF;

  IF v_exists THEN
    UPDATE public.processing_records SET
      record_type        = COALESCE(p_row->>'record_type', record_type),
      program            = COALESCE(p_row->>'program', program),
      title              = COALESCE(p_row->>'title', title),
      processing_date    = COALESCE((p_row->>'processing_date')::date, processing_date),
      status             = COALESCE(v_status, status),
      completed_at       = CASE WHEN COALESCE(v_status, status) = 'complete'
                                THEN COALESCE(completed_at,
                                              (COALESCE((p_row->>'processing_date')::date, processing_date)::timestamptz
                                                 + interval '12 hours'),
                                              now())
                                ELSE completed_at END,
      assignee_name      = CASE WHEN assignee_profile_id IS NOT NULL THEN assignee_name
                                ELSE COALESCE(p_row->>'assignee_name', assignee_name) END,
      assignee_profile_id = CASE WHEN assignee_profile_id IS NOT NULL THEN assignee_profile_id
                                 ELSE COALESCE(v_pid, assignee_profile_id) END,
      asana_project_gid  = COALESCE(p_row->>'asana_project_gid', asana_project_gid),
      asana_section_gid  = COALESCE(p_row->>'asana_section_gid', asana_section_gid),
      asana_section_name = COALESCE(p_row->>'asana_section_name', asana_section_name),
      match_status       = COALESCE(v_ms, match_status),
      historical_snapshot= COALESCE(p_row->'historical_snapshot', historical_snapshot),
      raw_asana_snapshot = COALESCE(p_row->'raw_asana_snapshot', raw_asana_snapshot),
      last_synced_at     = now(),
      sync_run_id        = COALESCE(p_row->>'sync_run_id', sync_run_id),
      updated_at         = now()
    WHERE id = v_id;
    v_action := 'updated';
  ELSE
    INSERT INTO public.processing_records (
      id, record_type, program, title, processing_date, status, number_processed,
      assignee_name, assignee_profile_id,
      source_kind, source_id, asana_gid, asana_project_gid, asana_section_gid,
      asana_section_name, match_status, historical_snapshot, raw_asana_snapshot,
      last_synced_at, sync_run_id, created_by
    ) VALUES (
      v_id, v_type,
      COALESCE(p_row->>'program', 'broiler'),
      COALESCE(p_row->>'title', '(untitled)'),
      (p_row->>'processing_date')::date,
      COALESCE(v_status, 'planned'),
      (p_row->>'number_processed')::int,
      p_row->>'assignee_name', v_pid,
      NULL, NULL,
      v_gid,
      p_row->>'asana_project_gid',
      p_row->>'asana_section_gid',
      p_row->>'asana_section_name',
      COALESCE(v_ms, 'unmatched'),
      COALESCE(p_row->'historical_snapshot', '{}'::jsonb),
      COALESCE(p_row->'raw_asana_snapshot', '{}'::jsonb),
      now(), p_row->>'sync_run_id', public._processing_import_actor()
    );
    IF COALESCE(v_status, 'planned') = 'complete' THEN
      UPDATE public.processing_records
         SET completed_at = COALESCE((p_row->>'processing_date')::date::timestamptz + interval '12 hours', now())
       WHERE id = v_id AND completed_at IS NULL;
    END IF;
    v_action := 'inserted';
  END IF;
  RETURN jsonb_build_object('id', v_id, 'action', v_action, 'asana_gid', v_gid);
END
$fn$;
REVOKE ALL ON FUNCTION public.upsert_processing_from_asana(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_processing_from_asana(jsonb) TO service_role;

-- ── 6. Fail-closed silent profile correction ────────────────────────────────
-- Resolves imported name-only Processing assignments (subtasks, record-level
-- assignee names, ACTIVE template checklist steps) to a real profile found by
-- normalized stable email. FAIL CLOSED: exactly one profile must match the
-- email, and it must hold an operational role. SILENT: no notifications and no
-- activity fan-out (this is a data correction, not workflow). No UUIDs or
-- emails are hardcoded — the gated apply flow passes the preflight-verified
-- email. Inactive template versions stay immutable.
CREATE OR REPLACE FUNCTION public.correct_processing_imported_assignee(
  p_display_name text, p_email text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_role text;
  v_pid uuid;
  v_matches int;
  v_target_role text;
  v_subtasks int := 0;
  v_records int := 0;
  v_tpl RECORD;
  v_templates int := 0;
  v_new jsonb;
  v_changed boolean;
BEGIN
  -- Admin caller or service_role (gated apply script).
  IF auth.uid() IS NOT NULL THEN
    v_role := public.profile_role();
    IF v_role IS NULL OR v_role <> 'admin' THEN
      RAISE EXCEPTION 'PROCESSING_VALIDATION: caller role % cannot run assignment corrections', COALESCE(v_role, 'null');
    END IF;
  END IF;
  IF COALESCE(btrim(p_display_name), '') = '' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: display name required';
  END IF;
  IF COALESCE(btrim(p_email), '') = '' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: email required';
  END IF;

  -- Fail-closed identity preflight: exactly one profile by normalized email,
  -- and it must be an active operational (Processing-capable) role.
  SELECT count(*) INTO v_matches
    FROM public.profiles WHERE lower(btrim(email)) = lower(btrim(p_email));
  IF v_matches <> 1 THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: email resolves to % profiles (need exactly 1)', v_matches;
  END IF;
  SELECT id, role INTO v_pid, v_target_role
    FROM public.profiles WHERE lower(btrim(email)) = lower(btrim(p_email));
  IF v_target_role IS NULL OR v_target_role NOT IN ('farm_team', 'management', 'admin') THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: resolved profile role % is not authorized for Processing', COALESCE(v_target_role, 'null');
  END IF;

  -- Subtasks: name-only assignments (no profile yet) matching the display name.
  UPDATE public.processing_subtasks
     SET assignee_profile_id = v_pid, assignee = NULL, updated_at = now()
   WHERE assignee_profile_id IS NULL
     AND lower(btrim(COALESCE(assignee, ''))) = lower(btrim(p_display_name));
  GET DIAGNOSTICS v_subtasks = ROW_COUNT;

  -- Record-level imported assignee names (parent assignee is retired from the
  -- UI, but the stored name should still resolve to the real profile).
  UPDATE public.processing_records
     SET assignee_profile_id = v_pid, assignee_name = NULL, updated_at = now()
   WHERE assignee_profile_id IS NULL
     AND lower(btrim(COALESCE(assignee_name, ''))) = lower(btrim(p_display_name));
  GET DIAGNOSTICS v_records = ROW_COUNT;

  -- ACTIVE template checklists only; historical versions stay immutable.
  FOR v_tpl IN SELECT id, checklist FROM public.processing_templates WHERE is_active = true LOOP
    v_changed := false;
    SELECT COALESCE(jsonb_agg(
             CASE
               WHEN COALESCE(btrim(COALESCE(step->>'assignee_profile_id', '')), '') = ''
                    AND lower(btrim(COALESCE(step->>'assignee', ''))) = lower(btrim(p_display_name))
               THEN step || jsonb_build_object('assignee', NULL, 'assignee_profile_id', v_pid::text)
               ELSE step
             END ORDER BY ord), '[]'::jsonb)
      INTO v_new
      FROM jsonb_array_elements(COALESCE(v_tpl.checklist, '[]'::jsonb)) WITH ORDINALITY AS t(step, ord);
    IF v_new IS DISTINCT FROM v_tpl.checklist THEN
      UPDATE public.processing_templates SET checklist = v_new WHERE id = v_tpl.id;
      v_templates := v_templates + 1;
      v_changed := true;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true,
    'subtasks_corrected', v_subtasks,
    'records_corrected', v_records,
    'templates_touched', v_templates);
END
$fn$;
REVOKE ALL ON FUNCTION public.correct_processing_imported_assignee(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_processing_imported_assignee(text, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
