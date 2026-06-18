-- ============================================================================
-- 133_task_system_generation_and_todo_notifications.sql
-- ----------------------------------------------------------------------------
-- Hotfix support for To Do approval notifications:
--   * add todo_completion_submitted to notifications_type_check
--   * notify every management/admin profile when a non-manager submits a To Do
--     completion that is waiting for approval
--   * keep creator completion notifications in approve/auto-approve paths from
--     mig 115 intact by reissuing submit_todo_completion only where the pending
--     manager fan-out is needed
--
-- System task generation itself is Edge Function code in tasks-cron; the
-- existing generate_system_task_instance RPC and task_system_rules schema stay
-- unchanged.
--
-- NO BEGIN/COMMIT in this file: TEST applies via exec_sql; PROD applies with
-- psql --single-transaction after approval.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Allow the new server-side notification type.
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('task_completed', 'mention', 'comment_mention',
                  'todo_completion_approved', 'todo_completion_rejected',
                  'todo_converted', 'todo_completion_submitted'));

-- Notify management/admin that a To Do is waiting for approval. This is a
-- SECURITY DEFINER helper only; no client EXECUTE grant.
CREATE OR REPLACE FUNCTION public._todo_notify_managers(
  p_actor       uuid,
  p_todo_title  text,
  p_body        text,
  p_activity_id text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $td_notify_mgr$
DECLARE
  v_actor_name text;
  v_title      text;
  v_body       text;
BEGIN
  IF p_actor IS NULL THEN
    RETURN;
  END IF;

  SELECT COALESCE(full_name, '') INTO v_actor_name
    FROM public.profiles WHERE id = p_actor;
  IF v_actor_name IS NULL OR length(btrim(v_actor_name)) = 0 THEN
    v_actor_name := 'Someone';
  END IF;

  v_title := v_actor_name || ' submitted a to do for approval: ' || COALESCE(p_todo_title, 'To Do');
  v_body := left(COALESCE(NULLIF(btrim(COALESCE(p_body, '')), ''), 'Waiting for manager approval.'), 200);

  INSERT INTO public.notifications
    (id, recipient_profile_id, actor_profile_id, type,
     task_instance_id, activity_event_id, title, body, created_at)
  SELECT
    'ntf-' || gen_random_uuid()::text,
    p.id,
    p_actor,
    'todo_completion_submitted',
    NULL,
    p_activity_id,
    v_title,
    v_body,
    now()
  FROM public.profiles p
  WHERE p.role IN ('management', 'admin')
    AND p.id IS DISTINCT FROM p_actor;
END
$td_notify_mgr$;

REVOKE ALL ON FUNCTION public._todo_notify_managers(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;

-- Reissue submit_todo_completion to add the manager notification fan-out on
-- the non-manager pending_approval branch. The manager auto-approve branch is
-- preserved from migration 115, including creator notification.
CREATE OR REPLACE FUNCTION public.submit_todo_completion(
  p_id          text,
  p_note        text DEFAULT NULL,
  p_photo_paths text[] DEFAULT '{}'::text[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $td_complete$
DECLARE
  v_caller  uuid := auth.uid();
  v_role    text;
  v_row     public.todo_items%ROWTYPE;
  v_manager boolean;
  v_count   int;
  v_ae_id   text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'submit_todo_completion: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('light', 'farm_team', 'management', 'admin') THEN
    RAISE EXCEPTION 'TODO_VALIDATION: caller role % cannot use the to do list', COALESCE(v_role, 'null');
  END IF;
  v_manager := v_role IN ('management', 'admin');

  SELECT * INTO v_row FROM public.todo_items WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TODO_VALIDATION: item % not found', p_id;
  END IF;

  -- Idempotent retry of the same pending submission.
  IF v_row.status = 'pending_approval' AND v_row.completion_submitted_by = v_caller THEN
    RETURN public._todo_item_summary(p_id) || jsonb_build_object('replayed', true);
  END IF;

  IF v_row.status <> 'open' THEN
    RAISE EXCEPTION 'TODO_VALIDATION: item % is not open (status %)', p_id, v_row.status;
  END IF;

  IF p_note IS NOT NULL AND length(p_note) > 2000 THEN
    RAISE EXCEPTION 'TODO_VALIDATION: completion note too long (max 2000)';
  END IF;

  PERFORM public._todo_validate_photo_paths(p_id, p_photo_paths);

  SELECT count(*) INTO v_count FROM public.todo_item_photos WHERE todo_id = p_id;
  IF v_count + COALESCE(array_length(p_photo_paths, 1), 0) > 5 THEN
    RAISE EXCEPTION 'TODO_VALIDATION: max 5 photos per to do item (% existing)', v_count;
  END IF;

  PERFORM public._todo_insert_photos(p_id, 'completion', p_photo_paths, v_caller);

  IF v_manager THEN
    UPDATE public.todo_items
       SET status = 'completed',
           completion_submitted_by = v_caller,
           completion_submitted_at = now(),
           completion_note = NULLIF(btrim(COALESCE(p_note, '')), ''),
           approved_by = v_caller,
           approved_at = now(),
           rejected_by = NULL,
           rejected_at = NULL,
           rejection_note = NULL,
           updated_at = now()
     WHERE id = p_id;

    v_ae_id := public._todo_log_activity(
      p_id, v_caller, 'todo.completion_approved',
      'Completed to do: ' || v_row.title,
      jsonb_build_object(
        'entity_label', v_row.title,
        'auto_approved', true,
        'completion_note', NULLIF(btrim(COALESCE(p_note, '')), '')));

    PERFORM public._todo_notify_creator(
      v_row.created_by, v_caller, 'todo_completion_approved',
      p_id, v_row.title, COALESCE(NULLIF(btrim(COALESCE(p_note, '')), ''), 'Completed.'), v_ae_id);
  ELSE
    UPDATE public.todo_items
       SET status = 'pending_approval',
           completion_submitted_by = v_caller,
           completion_submitted_at = now(),
           completion_note = NULLIF(btrim(COALESCE(p_note, '')), ''),
           updated_at = now()
     WHERE id = p_id;

    v_ae_id := public._todo_log_activity(
      p_id, v_caller, 'todo.completion_submitted',
      'Submitted completion for to do: ' || v_row.title,
      jsonb_build_object(
        'entity_label', v_row.title,
        'completion_note', NULLIF(btrim(COALESCE(p_note, '')), '')));

    PERFORM public._todo_notify_managers(
      v_caller,
      v_row.title,
      COALESCE(NULLIF(btrim(COALESCE(p_note, '')), ''), 'Waiting for manager approval.'),
      v_ae_id);
  END IF;

  RETURN public._todo_item_summary(p_id) || jsonb_build_object('replayed', false);
END
$td_complete$;

REVOKE ALL ON FUNCTION public.submit_todo_completion(text, text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_todo_completion(text, text, text[]) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- End of 133_task_system_generation_and_todo_notifications.sql
-- ============================================================================
