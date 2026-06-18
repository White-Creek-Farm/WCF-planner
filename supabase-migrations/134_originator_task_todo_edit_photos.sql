-- ============================================================================
-- 134_originator_task_todo_edit_photos.sql
-- ----------------------------------------------------------------------------
-- Originator editing follow-up for Tasks + To Do.
--
-- Tasks:
--   * Adds update_task_instance_details(), a SECURITY DEFINER RPC that lets an
--     admin or the logged-in creator edit an OPEN task's main details and append
--     more creation/request photos. Direct task_instances/task_instance_photos
--     writes stay blocked at RLS.
--
-- To Do:
--   * Re-issues update_todo_item() with an optional p_photo_paths argument so
--     the existing creator/manager edit path can append more origination photos.
--
-- Both paths preserve the shared 5-total-photo cap and append-only storage
-- model. Client uploads still happen before the RPC; the RPC validates that the
-- supplied DB paths are scoped to the record before it references them.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._task_validate_creation_photo_paths(
  p_instance_id text,
  p_paths text[]
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $task_edit_photo_validate$
DECLARE
  v_n int := COALESCE(array_length(p_paths, 1), 0);
  v_expected_prefix text := 'task-request-photos/' || p_instance_id || '/';
  v_idx int;
  v_path text;
  v_filename text;
BEGIN
  IF p_paths IS NULL OR v_n = 0 THEN
    RETURN;
  END IF;
  IF v_n > 5 THEN
    RAISE EXCEPTION 'update_task_instance_details: max 5 creation photos (% provided)', v_n;
  END IF;

  FOR v_idx IN 1..v_n LOOP
    v_path := p_paths[v_idx];
    IF v_path IS NULL OR length(btrim(v_path)) = 0 THEN
      RAISE EXCEPTION 'update_task_instance_details: creation photo path #% is empty', v_idx;
    END IF;
    IF position(v_expected_prefix in v_path) <> 1 THEN
      RAISE EXCEPTION 'update_task_instance_details: creation photo path #% must start with %',
        v_idx, v_expected_prefix;
    END IF;
    v_filename := substring(v_path from char_length(v_expected_prefix) + 1);
    IF v_filename IS NULL OR length(btrim(v_filename)) = 0 THEN
      RAISE EXCEPTION 'update_task_instance_details: creation photo path #% has empty filename', v_idx;
    END IF;
    IF position('/' in v_filename) > 0 OR position(chr(92) in v_filename) > 0 THEN
      RAISE EXCEPTION 'update_task_instance_details: creation photo path #% filename must not contain / or \',
        v_idx;
    END IF;
  END LOOP;
END
$task_edit_photo_validate$;

REVOKE ALL ON FUNCTION public._task_validate_creation_photo_paths(text, text[])
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.update_task_instance_details(
  p_instance_id text,
  p_title text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_due_date date DEFAULT NULL,
  p_assignee_profile_id uuid DEFAULT NULL,
  p_creation_photo_paths text[] DEFAULT '{}'::text[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $task_edit_details$
DECLARE
  v_caller uuid := auth.uid();
  v_admin boolean := public.is_admin();
  v_row public.task_instances%ROWTYPE;
  v_new_title text;
  v_new_description text;
  v_new_due_date date;
  v_new_assignee uuid;
  v_n int := COALESCE(array_length(p_creation_photo_paths, 1), 0);
  v_total_photos int := 0;
  v_next_creation_slot int := 0;
  v_idx int;
  v_path text;
  v_changed jsonb := '{}'::jsonb;
  v_activity_id text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'update_task_instance_details: authenticated caller required';
  END IF;
  IF p_instance_id IS NULL OR length(btrim(p_instance_id)) = 0 THEN
    RAISE EXCEPTION 'update_task_instance_details: instance_id required';
  END IF;

  SELECT * INTO v_row
    FROM public.task_instances
    WHERE id = p_instance_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'update_task_instance_details: instance % not found', p_instance_id;
  END IF;
  IF v_row.status = 'completed' THEN
    RAISE EXCEPTION 'update_task_instance_details: completed tasks are read-only';
  END IF;
  IF NOT v_admin AND v_row.created_by_profile_id IS DISTINCT FROM v_caller THEN
    RAISE EXCEPTION 'update_task_instance_details: only the creator or an admin may edit this task';
  END IF;

  PERFORM public._task_validate_creation_photo_paths(p_instance_id, p_creation_photo_paths);

  SELECT count(*) INTO v_total_photos
    FROM public.task_instance_photos
    WHERE instance_id = p_instance_id;

  -- Legacy fallback for any old row whose single-path columns somehow were not
  -- mirrored into the sidecar. The sidecar trigger/backfills normally make this
  -- branch unnecessary, but it keeps the user-facing cap honest.
  IF v_total_photos = 0 THEN
    v_total_photos := 0;
    IF v_row.request_photo_path IS NOT NULL THEN
      v_total_photos := v_total_photos + 1;
    END IF;
    IF v_row.completion_photo_path IS NOT NULL THEN
      v_total_photos := v_total_photos + 1;
    END IF;
  END IF;

  IF v_total_photos + v_n > 5 THEN
    RAISE EXCEPTION 'update_task_instance_details: max 5 photos per task (% existing)',
      v_total_photos;
  END IF;

  SELECT COALESCE(max(sort_order), CASE WHEN v_row.request_photo_path IS NOT NULL THEN 0 ELSE -1 END) + 1
    INTO v_next_creation_slot
    FROM public.task_instance_photos
    WHERE instance_id = p_instance_id AND kind = 'creation';

  IF v_n > 0 AND v_next_creation_slot + v_n - 1 > 4 THEN
    RAISE EXCEPTION 'update_task_instance_details: no creation photo slots left';
  END IF;

  v_new_title := v_row.title;
  IF p_title IS NOT NULL THEN
    IF length(btrim(p_title)) < 3 THEN
      RAISE EXCEPTION 'update_task_instance_details: title required (min 3 chars)';
    END IF;
    IF length(btrim(p_title)) > 140 THEN
      RAISE EXCEPTION 'update_task_instance_details: title too long (max 140)';
    END IF;
    v_new_title := btrim(p_title);
    IF v_new_title IS DISTINCT FROM v_row.title THEN
      v_changed := v_changed || jsonb_build_object(
        'title', jsonb_build_object('from', v_row.title, 'to', v_new_title));
    END IF;
  END IF;

  v_new_description := v_row.description;
  IF p_description IS NOT NULL THEN
    IF length(p_description) > 4000 THEN
      RAISE EXCEPTION 'update_task_instance_details: description too long (max 4000)';
    END IF;
    v_new_description := NULLIF(btrim(p_description), '');
    IF v_new_description IS DISTINCT FROM v_row.description THEN
      v_changed := v_changed || jsonb_build_object('description', true);
    END IF;
  END IF;

  v_new_due_date := v_row.due_date;
  IF p_due_date IS NOT NULL THEN
    v_new_due_date := p_due_date;
    IF v_new_due_date IS DISTINCT FROM v_row.due_date THEN
      v_changed := v_changed || jsonb_build_object(
        'due_date', jsonb_build_object('from', v_row.due_date, 'to', v_new_due_date));
    END IF;
  END IF;

  v_new_assignee := v_row.assignee_profile_id;
  IF p_assignee_profile_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = p_assignee_profile_id AND role IS DISTINCT FROM 'inactive'
    ) THEN
      RAISE EXCEPTION 'update_task_instance_details: target assignee % is not eligible',
        p_assignee_profile_id;
    END IF;
    v_new_assignee := p_assignee_profile_id;
    IF v_new_assignee IS DISTINCT FROM v_row.assignee_profile_id THEN
      v_changed := v_changed || jsonb_build_object(
        'assignee_profile_id',
        jsonb_build_object('from', v_row.assignee_profile_id, 'to', v_new_assignee));
    END IF;
  END IF;

  -- Insert sidecar photos before touching request_photo_path. If this is the
  -- first creation photo, the parent UPDATE below fires the legacy mirror
  -- trigger, which sees slot 0 already present and leaves our uploader id.
  IF v_n > 0 THEN
    FOR v_idx IN 1..v_n LOOP
      v_path := p_creation_photo_paths[v_idx];
      INSERT INTO public.task_instance_photos
        (id, instance_id, kind, storage_path, uploaded_by_profile_id, sort_order)
      VALUES
        ('tip-' || p_instance_id || '-r' || (v_next_creation_slot + v_idx - 1)::text,
         p_instance_id, 'creation', v_path, v_caller, v_next_creation_slot + v_idx - 1)
      ON CONFLICT (instance_id, kind, sort_order) DO UPDATE
        SET storage_path = EXCLUDED.storage_path,
            uploaded_by_profile_id = EXCLUDED.uploaded_by_profile_id;
    END LOOP;
    v_changed := v_changed || jsonb_build_object('creation_photos_added', v_n);
  END IF;

  UPDATE public.task_instances
     SET title = v_new_title,
         description = v_new_description,
         due_date = v_new_due_date,
         assignee_profile_id = v_new_assignee,
         request_photo_path = CASE
           WHEN request_photo_path IS NULL AND v_n > 0 THEN p_creation_photo_paths[1]
           ELSE request_photo_path
         END
   WHERE id = p_instance_id;

  IF v_changed <> '{}'::jsonb THEN
    v_activity_id := 'ae-' || gen_random_uuid()::text;
    INSERT INTO public.activity_events
      (id, entity_type, entity_id, actor_profile_id, event_type, body, payload)
    VALUES
      (v_activity_id, 'task.instance', p_instance_id, v_caller, 'record.updated',
       'Edited task: ' || v_row.title,
       jsonb_build_object('entity_label', v_row.title, 'changes', v_changed));
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'instance_id', p_instance_id,
    'title', v_new_title,
    'description', v_new_description,
    'due_date', v_new_due_date,
    'assignee_profile_id', v_new_assignee,
    'creation_photos_added', v_n,
    'activity_id', v_activity_id
  );
END
$task_edit_details$;

REVOKE ALL ON FUNCTION public.update_task_instance_details(text, text, text, date, uuid, text[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_task_instance_details(text, text, text, date, uuid, text[])
  TO authenticated;

-- Re-issue update_todo_item with photo append support. Drop the old six-arg
-- signature first so PostgREST has a single named-arg target with a defaulted
-- p_photo_paths parameter.
DROP FUNCTION IF EXISTS public.update_todo_item(text, text, text, text, date, boolean);

CREATE OR REPLACE FUNCTION public.update_todo_item(
  p_id             text,
  p_title          text DEFAULT NULL,
  p_description    text DEFAULT NULL,
  p_section        text DEFAULT NULL,
  p_due_date       date DEFAULT NULL,
  p_clear_due_date boolean DEFAULT false,
  p_photo_paths    text[] DEFAULT '{}'::text[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $td_update$
DECLARE
  v_caller      uuid := auth.uid();
  v_role        text;
  v_row         public.todo_items%ROWTYPE;
  v_manager     boolean;
  v_sort        int;
  v_photo_n     int := COALESCE(array_length(p_photo_paths, 1), 0);
  v_photo_count int;
  v_changed     jsonb := '{}'::jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'update_todo_item: authenticated caller required';
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

  IF v_row.status IN ('converted', 'removed') THEN
    RAISE EXCEPTION 'TODO_VALIDATION: item % can no longer be edited', p_id;
  END IF;
  IF v_row.status = 'open' THEN
    IF NOT v_manager AND v_row.created_by IS DISTINCT FROM v_caller THEN
      RAISE EXCEPTION 'TODO_VALIDATION: only the creator or a manager may edit this item';
    END IF;
  ELSE
    IF NOT v_manager THEN
      RAISE EXCEPTION 'TODO_VALIDATION: only a manager may edit a % item', v_row.status;
    END IF;
  END IF;

  PERFORM public._todo_validate_photo_paths(p_id, p_photo_paths);
  SELECT count(*) INTO v_photo_count FROM public.todo_item_photos WHERE todo_id = p_id;
  IF v_photo_count + v_photo_n > 5 THEN
    RAISE EXCEPTION 'TODO_VALIDATION: max 5 photos per to do item (% existing)', v_photo_count;
  END IF;

  IF p_title IS NOT NULL THEN
    IF length(btrim(p_title)) < 3 THEN
      RAISE EXCEPTION 'TODO_VALIDATION: title must be at least 3 characters';
    END IF;
    IF length(p_title) > 200 THEN
      RAISE EXCEPTION 'TODO_VALIDATION: title too long (max 200)';
    END IF;
    IF btrim(p_title) IS DISTINCT FROM v_row.title THEN
      v_changed := v_changed || jsonb_build_object('title', jsonb_build_object('from', v_row.title, 'to', btrim(p_title)));
    END IF;
    UPDATE public.todo_items SET title = btrim(p_title) WHERE id = p_id;
  END IF;

  IF p_description IS NOT NULL THEN
    IF length(p_description) > 4000 THEN
      RAISE EXCEPTION 'TODO_VALIDATION: description too long (max 4000)';
    END IF;
    IF NULLIF(btrim(p_description), '') IS DISTINCT FROM v_row.description THEN
      v_changed := v_changed || jsonb_build_object('description', true);
    END IF;
    UPDATE public.todo_items SET description = NULLIF(btrim(p_description), '') WHERE id = p_id;
  END IF;

  IF p_clear_due_date THEN
    IF v_row.due_date IS NOT NULL THEN
      v_changed := v_changed || jsonb_build_object('due_date', jsonb_build_object('from', v_row.due_date, 'to', NULL));
    END IF;
    UPDATE public.todo_items SET due_date = NULL WHERE id = p_id;
  ELSIF p_due_date IS NOT NULL THEN
    IF p_due_date IS DISTINCT FROM v_row.due_date THEN
      v_changed := v_changed || jsonb_build_object('due_date', jsonb_build_object('from', v_row.due_date, 'to', p_due_date));
    END IF;
    UPDATE public.todo_items SET due_date = p_due_date WHERE id = p_id;
  END IF;

  IF p_section IS NOT NULL AND p_section IS DISTINCT FROM v_row.section THEN
    IF p_section NOT IN ('general', 'chicken_pigs', 'cattle_sheep') THEN
      RAISE EXCEPTION 'TODO_VALIDATION: unknown section %', p_section;
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('todo_items_order'), hashtext(p_section));
    SELECT COALESCE(max(sort_order), -1) + 1
      INTO v_sort
      FROM public.todo_items
     WHERE section = p_section AND status IN ('open', 'pending_approval') AND id <> p_id;
    UPDATE public.todo_items SET section = p_section, sort_order = v_sort WHERE id = p_id;
    v_changed := v_changed || jsonb_build_object('section', jsonb_build_object('from', v_row.section, 'to', p_section));
  END IF;

  IF v_photo_n > 0 THEN
    PERFORM public._todo_insert_photos(p_id, 'origination', p_photo_paths, v_caller);
    v_changed := v_changed || jsonb_build_object('origination_photos_added', v_photo_n);
  END IF;

  UPDATE public.todo_items SET updated_at = now() WHERE id = p_id;

  IF v_changed <> '{}'::jsonb THEN
    PERFORM public._todo_log_activity(
      p_id, v_caller, 'record.updated',
      'Edited to do: ' || v_row.title,
      jsonb_build_object('entity_label', v_row.title, 'changes', v_changed));
  END IF;

  RETURN public._todo_item_summary(p_id);
END
$td_update$;

REVOKE ALL ON FUNCTION public.update_todo_item(text, text, text, text, date, boolean, text[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_todo_item(text, text, text, text, date, boolean, text[])
  TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- End of 134_originator_task_todo_edit_photos.sql
-- ============================================================================
