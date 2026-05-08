-- ============================================================================
-- 053_tasks_v2_rls_and_rpcs.sql
-- ----------------------------------------------------------------------------
-- Tasks v2 — RLS overhaul + 6 SECURITY DEFINER RPCs.
--
-- RLS changes:
--   * task_instances: drops the v1 assignee_self_select policy and adds a
--     new authenticated_select that lets every logged-in user SEE all
--     open and completed tasks (Codex transparency rule). Direct INSERT/
--     UPDATE/DELETE remain admin-only via the existing admin_all policy;
--     all non-admin mutations flow through the RPCs below.
--   * task_templates: gains an authenticated_select policy so every
--     logged-in user can see recurring templates. Direct write stays
--     admin-only via the existing task_templates_admin_all policy.
--
-- New RPCs (all SECURITY DEFINER, search_path public, anon REVOKE +
-- authenticated GRANT):
--   1. complete_task_instance(p_instance_id text, p_completion_note text,
--      p_completion_photo_paths text[] DEFAULT '{}') — v2 overload of the
--      v1 (text, text) signature. v1 stays in place so the legacy
--      MyTasksView path keeps working until T7 retires it. PostgREST
--      routes by named-arg match: bodies carrying p_completion_note hit
--      v2; bodies carrying p_completion_photo_path hit v1.
--   2. create_one_time_task_instance(p_instance jsonb,
--      p_creation_photo_paths text[] DEFAULT '{}') — any authenticated
--      user can create a one-time task. Server locks
--      created_by_profile_id and created_by_display_name from the caller's
--      profile.
--   3. update_task_instance_due_date(p_instance_id text,
--      p_new_due_date date) — admin unlimited; regular (assignee) max 2
--      edits enforced via due_date_edit_count, with an audit row inserted
--      every time.
--   4. assign_task_instance(p_instance_id text,
--      p_assignee_profile_id uuid) — admin only.
--   5. delete_task_instance(p_instance_id text) — admin can delete any
--      open task; regular user can delete an open task only if they
--      created it (created_by_profile_id == auth.uid()). Completed tasks
--      reject for everyone (final).
--   6. generate_system_task_instance(p_rule_id text, p_due_date date,
--      p_source_event_key text) — Edge Function caller; idempotent via
--      partial unique on (from_system_rule_id, due_date) created in
--      mig 050.
--
-- Hard gates honored (Codex's T1 list):
--   * Direct non-admin writes to task_instances stay blocked.
--   * Completed tasks cannot be deleted by anyone.
--   * Any authenticated user can SELECT all open/completed/recurring/
--     system rows.
--   * Any authenticated user can create a one-time task.
--   * Regular assignees can complete only their own tasks and edit only
--     their own due date, max 2 times.
--   * Admin can complete, assign, edit due dates unrestricted, and delete
--     open tasks.
--   * Regular users can delete only open tasks they created.
--   * Public webform submission (submit_task_instance from mig 041) is
--     not touched by this migration.
-- ============================================================================

-- ── 1. RLS overhaul ────────────────────────────────────────────────────────
DROP POLICY IF EXISTS task_instances_assignee_self_select ON public.task_instances;

DROP POLICY IF EXISTS task_instances_authenticated_select ON public.task_instances;
CREATE POLICY task_instances_authenticated_select
  ON public.task_instances FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS task_templates_authenticated_select ON public.task_templates;
CREATE POLICY task_templates_authenticated_select
  ON public.task_templates FOR SELECT
  TO authenticated
  USING (true);

-- ── 2. complete_task_instance v2 overload ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.complete_task_instance(
  p_instance_id text,
  p_completion_note text,
  p_completion_photo_paths text[] DEFAULT '{}'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $complete_v2$
DECLARE
  v_caller uuid := auth.uid();
  v_admin boolean := public.is_admin();
  v_row record;
  v_completed_at timestamptz := now();
  v_first_path text;
  v_idx int;
  v_n int := COALESCE(array_length(p_completion_photo_paths, 1), 0);
  v_path text;
  v_expected_prefix text;
  v_filename text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'complete_task_instance: authenticated caller required';
  END IF;
  IF p_completion_note IS NULL OR length(trim(p_completion_note)) = 0 THEN
    RAISE EXCEPTION 'complete_task_instance: completion_note required (non-empty)';
  END IF;
  IF v_n > 5 THEN
    RAISE EXCEPTION 'complete_task_instance: max 5 completion photos (% provided)', v_n;
  END IF;

  SELECT id, assignee_profile_id, status, completed_at
    INTO v_row
    FROM public.task_instances
    WHERE id = p_instance_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'complete_task_instance: instance % not found', p_instance_id;
  END IF;

  -- Auth check FIRST — even an idempotent replay should not return ok to
  -- a non-assignee/non-admin caller. Codex correction #3.
  IF NOT v_admin AND v_row.assignee_profile_id IS DISTINCT FROM v_caller THEN
    RAISE EXCEPTION 'complete_task_instance: caller % is not the assignee or admin', v_caller;
  END IF;

  -- Idempotent replay path AFTER the auth check.
  IF v_row.status = 'completed' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent_replay', true,
      'instance_id', p_instance_id,
      'completed_at', v_row.completed_at
    );
  END IF;

  -- Photo path validation: every path must match the expected prefix
  -- (task-photos/<row.assignee_profile_id>/<instance>/) and have a
  -- non-empty filename with no path separators. Mirrors the v1
  -- complete_task_instance(text, text) validation from mig 040.
  v_expected_prefix := 'task-photos/' || v_row.assignee_profile_id::text || '/' || p_instance_id || '/';
  IF v_n > 0 THEN
    FOR v_idx IN 1..v_n LOOP
      v_path := p_completion_photo_paths[v_idx];
      IF v_path IS NULL OR length(trim(v_path)) = 0 THEN
        RAISE EXCEPTION 'complete_task_instance: completion photo path #% is empty', v_idx;
      END IF;
      IF position(v_expected_prefix in v_path) <> 1 THEN
        RAISE EXCEPTION 'complete_task_instance: completion photo path #% must start with %', v_idx, v_expected_prefix;
      END IF;
      v_filename := substring(v_path from char_length(v_expected_prefix) + 1);
      IF v_filename IS NULL OR length(trim(v_filename)) = 0 THEN
        RAISE EXCEPTION 'complete_task_instance: completion photo path #% has empty filename', v_idx;
      END IF;
      IF position('/' in v_filename) > 0 OR position('\' in v_filename) > 0 THEN
        RAISE EXCEPTION 'complete_task_instance: completion photo path #% filename must not contain / or \', v_idx;
      END IF;
    END LOOP;
  END IF;

  v_first_path := CASE WHEN v_n > 0 THEN p_completion_photo_paths[1] ELSE NULL END;

  UPDATE public.task_instances
  SET status = 'completed',
      completed_at = v_completed_at,
      completed_by_profile_id = v_caller,
      completion_note = p_completion_note,
      completion_photo_path = COALESCE(v_first_path, completion_photo_path)
  WHERE id = p_instance_id AND status = 'open';

  IF NOT FOUND THEN
    SELECT completed_at INTO v_row.completed_at
      FROM public.task_instances
      WHERE id = p_instance_id;
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent_replay', true,
      'instance_id', p_instance_id,
      'completed_at', v_row.completed_at
    );
  END IF;

  -- Mirror new photos into the sidecar. The AFTER trigger fires first on
  -- the UPDATE that wrote completion_photo_path, leaving a sort_order=0
  -- row with uploaded_by_profile_id NULL. We RECLAIM that slot here so
  -- v2 callers always see the actual uploader id (Codex T1 reclaim fix).
  IF v_n > 0 THEN
    FOR v_idx IN 1..v_n LOOP
      v_path := p_completion_photo_paths[v_idx];
      IF v_path IS NULL OR length(trim(v_path)) = 0 THEN
        CONTINUE;
      END IF;
      INSERT INTO public.task_instance_photos
        (id, instance_id, kind, storage_path, uploaded_by_profile_id, sort_order)
      VALUES
        ('tip-' || p_instance_id || '-c' || (v_idx - 1)::text,
         p_instance_id, 'completion', v_path, v_caller, v_idx - 1)
      ON CONFLICT (instance_id, kind, sort_order) DO UPDATE
        SET storage_path = EXCLUDED.storage_path,
            uploaded_by_profile_id = EXCLUDED.uploaded_by_profile_id;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent_replay', false,
    'instance_id', p_instance_id,
    'completed_at', v_completed_at,
    'completed_by_profile_id', v_caller
  );
END;
$complete_v2$;

REVOKE ALL ON FUNCTION public.complete_task_instance(text, text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_task_instance(text, text, text[]) TO authenticated;

-- ── 3. create_one_time_task_instance ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_one_time_task_instance(
  p_instance jsonb,
  p_creation_photo_paths text[] DEFAULT '{}'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $create_one_time$
DECLARE
  v_caller uuid := auth.uid();
  v_caller_name text;
  v_id text := p_instance->>'id';
  v_csid text := p_instance->>'client_submission_id';
  v_title text := p_instance->>'title';
  v_description text := p_instance->>'description';
  v_due_date_text text := p_instance->>'due_date';
  v_assignee_text text := p_instance->>'assignee_profile_id';
  v_assignee uuid;
  v_due_date date;
  v_n int := COALESCE(array_length(p_creation_photo_paths, 1), 0);
  v_idx int;
  v_path text;
  v_first_path text;
  v_inserted_id text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'create_one_time_task_instance: authenticated caller required';
  END IF;
  IF v_id IS NULL OR length(trim(v_id)) = 0 THEN
    RAISE EXCEPTION 'create_one_time_task_instance: id required';
  END IF;
  IF v_csid IS NULL OR length(trim(v_csid)) = 0 THEN
    RAISE EXCEPTION 'create_one_time_task_instance: client_submission_id required';
  END IF;
  IF v_title IS NULL OR length(trim(v_title)) < 3 THEN
    RAISE EXCEPTION 'create_one_time_task_instance: title required (min 3 chars)';
  END IF;
  IF v_description IS NULL OR length(trim(v_description)) = 0 THEN
    RAISE EXCEPTION 'create_one_time_task_instance: description required';
  END IF;
  IF v_due_date_text IS NULL OR length(trim(v_due_date_text)) = 0 THEN
    RAISE EXCEPTION 'create_one_time_task_instance: due_date required';
  END IF;
  IF v_assignee_text IS NULL OR length(trim(v_assignee_text)) = 0 THEN
    RAISE EXCEPTION 'create_one_time_task_instance: assignee_profile_id required';
  END IF;
  IF v_n > 5 THEN
    RAISE EXCEPTION 'create_one_time_task_instance: max 5 creation photos (% provided)', v_n;
  END IF;

  v_due_date := v_due_date_text::date;
  v_assignee := v_assignee_text::uuid;

  -- Resolve caller's display name (locked server-side; admin call still
  -- uses caller's own profile name per Codex spec).
  SELECT full_name INTO v_caller_name FROM public.profiles WHERE id = v_caller;
  IF v_caller_name IS NULL OR length(trim(v_caller_name)) = 0 THEN
    v_caller_name := 'Unknown';
  END IF;

  -- Validate assignee is eligible.
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_assignee AND role IS DISTINCT FROM 'inactive'
  ) THEN
    RAISE EXCEPTION 'create_one_time_task_instance: assignee % is not eligible', v_assignee;
  END IF;

  -- Photo path validation for creation photos: every path must match
  -- task-request-photos/<instance>/<filename> with non-empty filename
  -- and no path separators inside the filename. Mirrors the v1
  -- request photo validation from mig 042.
  DECLARE
    v_expected_prefix text := 'task-request-photos/' || v_id || '/';
    v_chk_idx int;
    v_chk_path text;
    v_chk_filename text;
  BEGIN
    IF v_n > 0 THEN
      FOR v_chk_idx IN 1..v_n LOOP
        v_chk_path := p_creation_photo_paths[v_chk_idx];
        IF v_chk_path IS NULL OR length(trim(v_chk_path)) = 0 THEN
          RAISE EXCEPTION 'create_one_time_task_instance: creation photo path #% is empty', v_chk_idx;
        END IF;
        IF position(v_expected_prefix in v_chk_path) <> 1 THEN
          RAISE EXCEPTION 'create_one_time_task_instance: creation photo path #% must start with %', v_chk_idx, v_expected_prefix;
        END IF;
        v_chk_filename := substring(v_chk_path from char_length(v_expected_prefix) + 1);
        IF v_chk_filename IS NULL OR length(trim(v_chk_filename)) = 0 THEN
          RAISE EXCEPTION 'create_one_time_task_instance: creation photo path #% has empty filename', v_chk_idx;
        END IF;
        IF position('/' in v_chk_filename) > 0 OR position('\' in v_chk_filename) > 0 THEN
          RAISE EXCEPTION 'create_one_time_task_instance: creation photo path #% filename must not contain / or \', v_chk_idx;
        END IF;
      END LOOP;
    END IF;
  END;

  -- Idempotent insert by client_submission_id.
  v_first_path := CASE WHEN v_n > 0 THEN p_creation_photo_paths[1] ELSE NULL END;

  INSERT INTO public.task_instances (
    id, template_id, assignee_profile_id, due_date, title, description,
    submitted_by_team_member, submission_source, status,
    request_photo_path, client_submission_id,
    created_by_profile_id, created_by_display_name,
    from_recurring_template, designation
  )
  VALUES (
    v_id, NULL, v_assignee, v_due_date, v_title, v_description,
    NULL, 'admin_manual', 'open',
    v_first_path, v_csid,
    v_caller, v_caller_name,
    false, NULL
  )
  ON CONFLICT (client_submission_id) DO NOTHING
  RETURNING id INTO v_inserted_id;

  IF v_inserted_id IS NULL THEN
    -- Replay: csid already used. Find the existing row for the response.
    SELECT id INTO v_inserted_id
      FROM public.task_instances
      WHERE client_submission_id = v_csid
      LIMIT 1;
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent_replay', true,
      'instance_id', v_inserted_id
    );
  END IF;

  -- Mirror creation photos into the sidecar. The AFTER trigger fires on
  -- the parent INSERT and pre-occupies sort_order=0 with NULL uploaded_by;
  -- this RECLAIMS that slot so v2 callers see the actual uploader id
  -- (Codex T1 reclaim fix).
  IF v_n > 0 THEN
    FOR v_idx IN 1..v_n LOOP
      v_path := p_creation_photo_paths[v_idx];
      IF v_path IS NULL OR length(trim(v_path)) = 0 THEN
        CONTINUE;
      END IF;
      INSERT INTO public.task_instance_photos
        (id, instance_id, kind, storage_path, uploaded_by_profile_id, sort_order)
      VALUES
        ('tip-' || v_inserted_id || '-r' || (v_idx - 1)::text,
         v_inserted_id, 'creation', v_path, v_caller, v_idx - 1)
      ON CONFLICT (instance_id, kind, sort_order) DO UPDATE
        SET storage_path = EXCLUDED.storage_path,
            uploaded_by_profile_id = EXCLUDED.uploaded_by_profile_id;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent_replay', false,
    'instance_id', v_inserted_id,
    'created_by_profile_id', v_caller,
    'created_by_display_name', v_caller_name
  );
END;
$create_one_time$;

REVOKE ALL ON FUNCTION public.create_one_time_task_instance(jsonb, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_one_time_task_instance(jsonb, text[]) TO authenticated;

-- ── 4. update_task_instance_due_date ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_task_instance_due_date(
  p_instance_id text,
  p_new_due_date date
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $update_due$
DECLARE
  v_caller uuid := auth.uid();
  v_admin boolean := public.is_admin();
  v_row record;
  v_role text := CASE WHEN v_admin THEN 'admin' ELSE 'regular' END;
  v_audit_id text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'update_task_instance_due_date: authenticated caller required';
  END IF;
  IF p_new_due_date IS NULL THEN
    RAISE EXCEPTION 'update_task_instance_due_date: new_due_date required';
  END IF;

  SELECT id, assignee_profile_id, due_date, status, due_date_edit_count
    INTO v_row
    FROM public.task_instances
    WHERE id = p_instance_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'update_task_instance_due_date: instance % not found', p_instance_id;
  END IF;

  IF v_row.status = 'completed' THEN
    RAISE EXCEPTION 'update_task_instance_due_date: completed tasks are read-only';
  END IF;

  -- Auth: admin always; regular user must be assignee.
  IF NOT v_admin AND v_row.assignee_profile_id IS DISTINCT FROM v_caller THEN
    RAISE EXCEPTION 'update_task_instance_due_date: caller % is not the assignee', v_caller;
  END IF;

  -- Regular-user 2-edit cap. Admin edits do not consume the regular cap.
  IF NOT v_admin AND v_row.due_date_edit_count >= 2 THEN
    RAISE EXCEPTION 'update_task_instance_due_date: regular-user edit limit reached (2/2)';
  END IF;

  -- Same-date guard: writing the same date is a no-op (avoids audit churn).
  IF v_row.due_date = p_new_due_date THEN
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent_replay', true,
      'instance_id', p_instance_id,
      'due_date', v_row.due_date,
      'due_date_edit_count', v_row.due_date_edit_count
    );
  END IF;

  -- UUID-based audit id avoids count+1 collisions under concurrent
  -- edits. Codex correction #9 — human readability is not worth the race.
  v_audit_id := 'tdde-' || gen_random_uuid()::text;
  INSERT INTO public.task_instance_due_date_edits
    (id, instance_id, edited_at, edited_by_profile_id, edited_by_role,
     prior_due_date, new_due_date)
  VALUES
    (v_audit_id, p_instance_id, now(), v_caller, v_role,
     v_row.due_date, p_new_due_date);

  -- Bump count only for regular edits per Codex spec ("Admin changes do
  -- not count against the regular-user 2-edit limit").
  IF v_admin THEN
    UPDATE public.task_instances
      SET due_date = p_new_due_date
      WHERE id = p_instance_id;
  ELSE
    UPDATE public.task_instances
      SET due_date = p_new_due_date,
          due_date_edit_count = due_date_edit_count + 1
      WHERE id = p_instance_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent_replay', false,
    'instance_id', p_instance_id,
    'due_date', p_new_due_date,
    'edited_by_role', v_role,
    'audit_id', v_audit_id
  );
END;
$update_due$;

REVOKE ALL ON FUNCTION public.update_task_instance_due_date(text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_task_instance_due_date(text, date) TO authenticated;

-- ── 5. assign_task_instance (admin-only) ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.assign_task_instance(
  p_instance_id text,
  p_assignee_profile_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $assign_ti$
DECLARE
  v_caller uuid := auth.uid();
  v_admin boolean := public.is_admin();
  v_row record;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'assign_task_instance: authenticated caller required';
  END IF;
  IF NOT v_admin THEN
    RAISE EXCEPTION 'assign_task_instance: admin only';
  END IF;
  IF p_assignee_profile_id IS NULL THEN
    RAISE EXCEPTION 'assign_task_instance: assignee_profile_id required';
  END IF;

  SELECT id, status INTO v_row FROM public.task_instances WHERE id = p_instance_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'assign_task_instance: instance % not found', p_instance_id;
  END IF;
  IF v_row.status = 'completed' THEN
    RAISE EXCEPTION 'assign_task_instance: completed tasks are read-only';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = p_assignee_profile_id AND role IS DISTINCT FROM 'inactive'
  ) THEN
    RAISE EXCEPTION 'assign_task_instance: target assignee % is not eligible', p_assignee_profile_id;
  END IF;

  UPDATE public.task_instances
    SET assignee_profile_id = p_assignee_profile_id
    WHERE id = p_instance_id;

  RETURN jsonb_build_object(
    'ok', true,
    'instance_id', p_instance_id,
    'assignee_profile_id', p_assignee_profile_id
  );
END;
$assign_ti$;

REVOKE ALL ON FUNCTION public.assign_task_instance(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assign_task_instance(text, uuid) TO authenticated;

-- ── 6. delete_task_instance ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.delete_task_instance(
  p_instance_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $delete_ti$
DECLARE
  v_caller uuid := auth.uid();
  v_admin boolean := public.is_admin();
  v_row record;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'delete_task_instance: authenticated caller required';
  END IF;

  SELECT id, status, created_by_profile_id, assignee_profile_id
    INTO v_row
    FROM public.task_instances
    WHERE id = p_instance_id;

  IF NOT FOUND THEN
    -- Idempotent: already deleted treated as success.
    RETURN jsonb_build_object('ok', true, 'instance_id', p_instance_id, 'idempotent_replay', true);
  END IF;

  IF v_row.status = 'completed' THEN
    RAISE EXCEPTION 'delete_task_instance: completed tasks cannot be deleted';
  END IF;

  IF NOT v_admin THEN
    -- Regular users can delete only OPEN tasks they assigned to
    -- THEMSELVES (creator AND assignee both must be the caller). Codex
    -- correction #2: a regular user creating a task for someone else
    -- cannot then delete it out from under that assignee.
    IF v_row.created_by_profile_id IS DISTINCT FROM v_caller
       OR v_row.assignee_profile_id IS DISTINCT FROM v_caller THEN
      RAISE EXCEPTION 'delete_task_instance: regular users can delete only open tasks they assigned to themselves';
    END IF;
  END IF;

  DELETE FROM public.task_instances WHERE id = p_instance_id;
  RETURN jsonb_build_object('ok', true, 'instance_id', p_instance_id, 'idempotent_replay', false);
END;
$delete_ti$;

REVOKE ALL ON FUNCTION public.delete_task_instance(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_task_instance(text) TO authenticated;

-- ── 7. generate_system_task_instance (Edge Function caller) ────────────────
CREATE OR REPLACE FUNCTION public.generate_system_task_instance(
  p_rule_id text,
  p_due_date date,
  p_source_event_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $gen_system$
DECLARE
  v_rule record;
  v_caller uuid := auth.uid();
  v_admin boolean := public.is_admin();
  v_instance_id text;
BEGIN
  -- Caller must be admin OR service_role (Edge Function path).
  -- Service role calls bypass auth.uid() (returns NULL) but the function
  -- runs as definer; we accept service_role-shaped callers by checking
  -- (v_caller IS NULL means service role) OR v_admin.
  IF v_caller IS NOT NULL AND NOT v_admin THEN
    RAISE EXCEPTION 'generate_system_task_instance: admin or service caller required';
  END IF;

  IF p_rule_id IS NULL OR length(trim(p_rule_id)) = 0 THEN
    RAISE EXCEPTION 'generate_system_task_instance: rule_id required';
  END IF;
  IF p_due_date IS NULL THEN
    RAISE EXCEPTION 'generate_system_task_instance: due_date required';
  END IF;
  IF p_source_event_key IS NULL OR length(trim(p_source_event_key)) = 0 THEN
    RAISE EXCEPTION 'generate_system_task_instance: source_event_key required';
  END IF;

  SELECT id, name, description, assignee_profile_id, generator_kind, active
    INTO v_rule
    FROM public.task_system_rules
    WHERE id = p_rule_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'generate_system_task_instance: rule % not found', p_rule_id;
  END IF;
  IF NOT v_rule.active THEN
    RAISE EXCEPTION 'generate_system_task_instance: rule % is inactive', p_rule_id;
  END IF;

  -- Deterministic instance id (rule + event key) so retries idempotent.
  v_instance_id := 'tisys-' || p_rule_id || '-' || p_source_event_key;

  -- Idempotency via the deterministic instance_id and the partial unique
  -- on (from_system_rule_id, from_system_source_event_key). Two distinct
  -- event keys (e.g., two different broiler batches) for the same rule
  -- and same due_date both succeed — they are different events and
  -- legitimately produce two tasks.
  INSERT INTO public.task_instances (
    id, template_id, assignee_profile_id, due_date, title, description,
    submitted_by_team_member, submission_source, status,
    from_system_rule_id, from_system_source_event_key, designation
  )
  VALUES (
    v_instance_id, NULL, v_rule.assignee_profile_id, p_due_date,
    v_rule.name, v_rule.description,
    NULL, 'admin_manual', 'open',
    v_rule.id, p_source_event_key, 'system'
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN jsonb_build_object(
    'ok', true,
    'instance_id', v_instance_id,
    'rule_id', p_rule_id,
    'due_date', p_due_date,
    'source_event_key', p_source_event_key
  );
END;
$gen_system$;

REVOKE ALL ON FUNCTION public.generate_system_task_instance(text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_system_task_instance(text, date, text) TO authenticated;
-- Edge Function service-role intent should be loud (matches the existing
-- generate_task_instances grant pattern). Codex correction #6.
GRANT EXECUTE ON FUNCTION public.generate_system_task_instance(text, date, text) TO service_role;

-- ── 8. BEFORE INSERT trigger: auto-set v2 designation flags ────────────────
-- Codex correction #7: existing generate_task_instances (mig 039) inserts
-- task_instances rows without setting from_recurring_template/designation.
-- Rather than overwrite that RPC (and its lookalikes in admin paths), set
-- the v2 flags via a BEFORE INSERT trigger. Same shape applies to system-
-- rule inserts going through generate_system_task_instance — but that
-- function already sets the values explicitly, so the trigger's COALESCE
-- preserves explicit settings.
CREATE OR REPLACE FUNCTION public._tasks_v2_set_designation()
RETURNS trigger
LANGUAGE plpgsql
AS $set_designation$
BEGIN
  IF NEW.template_id IS NOT NULL AND NOT NEW.from_recurring_template THEN
    NEW.from_recurring_template := true;
  END IF;
  IF NEW.designation IS NULL THEN
    IF NEW.template_id IS NOT NULL THEN
      NEW.designation := 'recurring';
    ELSIF NEW.from_system_rule_id IS NOT NULL THEN
      NEW.designation := 'system';
    END IF;
  END IF;
  RETURN NEW;
END;
$set_designation$;

DROP TRIGGER IF EXISTS task_instances_set_designation ON public.task_instances;
CREATE TRIGGER task_instances_set_designation
  BEFORE INSERT ON public.task_instances
  FOR EACH ROW
  EXECUTE FUNCTION public._tasks_v2_set_designation();

-- ── 9. AFTER INSERT/UPDATE trigger: mirror legacy photo columns to sidecar ─
-- Codex correction #8: keep submit_task_instance (mig 041/042) signature
-- intact, but mirror its request_photo_path write into
-- task_instance_photos so v2 readers see uploaded photos uniformly. Same
-- mirror covers the v1 complete_task_instance UPDATE that writes
-- completion_photo_path. The trigger fires BEFORE the v2 RPCs' manual
-- sidecar inserts (because the parent task_instances INSERT/UPDATE
-- completes first), so this row lands with uploaded_by_profile_id NULL.
-- The v2 RPCs use ON CONFLICT DO UPDATE to RECLAIM the slot and write
-- the actual uploader id; legacy/public paths leave the NULL row in
-- place since they have no caller-id source.
CREATE OR REPLACE FUNCTION public._tasks_v2_mirror_photo_paths()
RETURNS trigger
LANGUAGE plpgsql
AS $mirror_photos$
BEGIN
  IF NEW.request_photo_path IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.request_photo_path IS DISTINCT FROM NEW.request_photo_path) THEN
    INSERT INTO public.task_instance_photos
      (id, instance_id, kind, storage_path, sort_order)
    VALUES
      ('tip-' || NEW.id || '-r0', NEW.id, 'creation', NEW.request_photo_path, 0)
    ON CONFLICT (instance_id, kind, sort_order) DO NOTHING;
  END IF;
  IF NEW.completion_photo_path IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.completion_photo_path IS DISTINCT FROM NEW.completion_photo_path) THEN
    INSERT INTO public.task_instance_photos
      (id, instance_id, kind, storage_path, sort_order)
    VALUES
      ('tip-' || NEW.id || '-c0', NEW.id, 'completion', NEW.completion_photo_path, 0)
    ON CONFLICT (instance_id, kind, sort_order) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$mirror_photos$;

DROP TRIGGER IF EXISTS task_instances_mirror_photo_paths ON public.task_instances;
CREATE TRIGGER task_instances_mirror_photo_paths
  AFTER INSERT OR UPDATE ON public.task_instances
  FOR EACH ROW
  EXECUTE FUNCTION public._tasks_v2_mirror_photo_paths();

-- ============================================================================
-- End of 053_tasks_v2_rls_and_rpcs.sql
-- v1 complete_task_instance(text, text DEFAULT NULL) is intentionally NOT
-- dropped. PostgREST routes by named-arg match: bodies carrying
-- p_completion_note hit v2 (this migration); bodies carrying
-- p_completion_photo_path hit v1 (mig 040). The legacy /my-tasks path
-- keeps working until T7 retires it; a future cleanup commit drops v1
-- after T11.
--
-- BEFORE INSERT trigger covers the existing generate_task_instances
-- (mig 039) without overwriting it; new recurring instances get
-- from_recurring_template=true and designation='recurring' automatically.
--
-- AFTER INSERT/UPDATE trigger covers submit_task_instance (mig 041/042)
-- and v1 complete_task_instance (mig 040) without overwriting them; the
-- trigger lands sort_order=0 with NULL uploaded_by_profile_id, then the
-- v2 RPCs reclaim the slot via ON CONFLICT DO UPDATE to fill in the
-- actual uploader id. Legacy/public callers leave the NULL row in place.
-- ============================================================================
