-- ============================================================================
-- 115_todo_items.sql
-- ----------------------------------------------------------------------------
-- Shared To Do List: a communal repository of open, unassigned work inside the
-- Task Center (/tasks, meaty Task Center | To Do List toggle). Anyone in the
-- To Do role set can add an item or submit its completion; only management/
-- admin approve, reject, reorder, move, convert, or remove. Items live in one
-- of three fixed sections (general / chicken_pigs / cattle_sheep) with manual
-- priority via sort_order.
--
-- 1. todo_items + todo_item_photos tables (deny-all RLS, REVOKE ALL;
--    SECDEF-only access, mig 071/112 pattern).
-- 2. Photo cap trigger: 5 photos TOTAL per item across origination plus
--    completion (mig 114 pattern, advisory-lock serialized).
-- 3. SECDEF RPC family: create_todo_item, list_todo_items, update_todo_item,
--    submit_todo_completion, approve_todo_completion, reject_todo_completion,
--    reorder_todo_items, move_todo_item, convert_todo_item, remove_todo_item.
--    Roles: light/farm_team/management/admin participate; management/admin
--    manage. equipment_tech and inactive have NO To Do access.
-- 4. Status model: open -> pending_approval -> completed. A management/admin
--    completion submit auto-approves (single step). Rejection returns the item
--    to open, preserving the submitted note/photos in the item's Activity
--    history. converted/removed are terminal hidden states (never listed).
-- 5. Convert: convert_todo_item internally calls the mig 053
--    create_one_time_task_instance RPC (full validation reuse) and marks the
--    item converted in the SAME transaction. The To Do disappears from the
--    To Do UI only after the Task exists.
-- 6. Photos live in the existing PRIVATE task-photos bucket under the
--    'todo/<todoId>/' path prefix. Mig 038 policies are bucket-scoped
--    (authenticated INSERT/SELECT on bucket_id='task-photos'), so NO storage
--    policy change is needed. RPCs validate the path prefix server-side.
-- 7. Notifications: creator is notified on approve / reject / convert via new
--    types todo_completion_approved / todo_completion_rejected /
--    todo_converted (notifications_type_check re-issued). Each notification
--    carries activity_event_id so the existing list_recent_notifications
--    entity resolution (ae.entity_type branch) routes it to /tasks/todo/<id>;
--    todo_converted also carries task_instance_id so the client can route to
--    the created Task.
-- 8. _activity_can_read re-issued (faithful copy of the mig 112 definition,
--    preserving every branch incl. cattle.log) with a 'todo.item' branch:
--    row existence + explicit role gate (light/farm_team/management/admin).
--    _activity_can_write is re-issued verbatim with an updated comment only:
--    todo.item deliberately has NO write branch, so generic post_comment /
--    edit_comment / delete_comment work on To Do record pages for the same
--    role set via the can_read delegation (comments are plain discussion
--    here, unlike cattle.log entries which are RPC-managed).
--
-- Error classes: deterministic failures use the 'TODO_VALIDATION:' prefix.
-- The bare 'authenticated caller required' message stays UNprefixed (mig 112
-- convention).
--
-- NO BEGIN/COMMIT in this file: TEST applies via exec_sql (rejects them);
-- PROD applies with psql --single-transaction for atomicity.
-- Apply order: TEST first, PROD after lane approval.
-- Depends on: mig 053 (create_one_time_task_instance), mig 071 (comments/
-- notifications), mig 112 (latest _activity_can_read/_activity_can_write).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── 1. todo_items table ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.todo_items (
  id                      text PRIMARY KEY,
  title                   text NOT NULL,
  description             text,
  section                 text NOT NULL
                            CHECK (section IN ('general', 'chicken_pigs', 'cattle_sheep')),
  status                  text NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open', 'pending_approval', 'completed', 'converted', 'removed')),
  sort_order              int NOT NULL DEFAULT 0,
  due_date                date,
  created_by              uuid NOT NULL REFERENCES public.profiles(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  completion_submitted_by uuid REFERENCES public.profiles(id),
  completion_submitted_at timestamptz,
  completion_note         text,
  approved_by             uuid REFERENCES public.profiles(id),
  approved_at             timestamptz,
  rejected_by             uuid REFERENCES public.profiles(id),
  rejected_at             timestamptz,
  rejection_note          text,
  converted_task_id       text REFERENCES public.task_instances(id) ON DELETE SET NULL,
  converted_by            uuid REFERENCES public.profiles(id),
  converted_at            timestamptz,
  removed_by              uuid REFERENCES public.profiles(id),
  removed_at              timestamptz
);

-- Active-list read path: section ordering for open/pending rows.
CREATE INDEX IF NOT EXISTS todo_items_active_section_idx
  ON public.todo_items (section, sort_order)
  WHERE status IN ('open', 'pending_approval');

-- Completed-section read path: newest approved first.
CREATE INDEX IF NOT EXISTS todo_items_completed_idx
  ON public.todo_items (approved_at DESC)
  WHERE status = 'completed';

REVOKE ALL ON TABLE public.todo_items FROM PUBLIC, anon, authenticated;

ALTER TABLE public.todo_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS todo_items_deny_all ON public.todo_items;
CREATE POLICY todo_items_deny_all ON public.todo_items
  FOR ALL USING (false);

-- ── 2. todo_item_photos table + 5-total cap trigger ─────────────────────────

CREATE TABLE IF NOT EXISTS public.todo_item_photos (
  id           text PRIMARY KEY,
  todo_id      text NOT NULL REFERENCES public.todo_items(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('origination', 'completion')),
  storage_path text NOT NULL,
  sort_order   int NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 4),
  uploaded_by  uuid REFERENCES public.profiles(id),
  uploaded_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (todo_id, kind, sort_order)
);

CREATE INDEX IF NOT EXISTS todo_item_photos_todo_idx
  ON public.todo_item_photos (todo_id, kind, sort_order);

REVOKE ALL ON TABLE public.todo_item_photos FROM PUBLIC, anon, authenticated;

ALTER TABLE public.todo_item_photos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS todo_item_photos_deny_all ON public.todo_item_photos;
CREATE POLICY todo_item_photos_deny_all ON public.todo_item_photos
  FOR ALL USING (false);

-- 5-total DB backstop (mig 114 pattern): origination + completion combined.
CREATE OR REPLACE FUNCTION public._enforce_todo_item_photos_max_5_total()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_count int;
BEGIN
  IF NEW.todo_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Serialize inserts for one item so two concurrent uploads cannot both
  -- observe the same remaining slot.
  PERFORM pg_advisory_xact_lock(hashtext('todo_item_photos'), hashtext(NEW.todo_id));

  -- An exact-slot conflict cannot increase the total row count; allow the
  -- ON CONFLICT/update path to proceed.
  IF TG_OP = 'INSERT' AND EXISTS (
    SELECT 1
    FROM public.todo_item_photos
    WHERE todo_id = NEW.todo_id
      AND kind = NEW.kind
      AND sort_order = NEW.sort_order
  ) THEN
    RETURN NEW;
  END IF;

  -- A same-item update cannot increase the total number of photos.
  IF TG_OP = 'UPDATE' AND OLD.todo_id = NEW.todo_id THEN
    RETURN NEW;
  END IF;

  SELECT count(*)
    INTO v_count
    FROM public.todo_item_photos
    WHERE todo_id = NEW.todo_id;

  IF v_count >= 5 THEN
    RAISE EXCEPTION 'todo_item_photos: max 5 photos per to do item';
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS todo_item_photos_max_5_total
  ON public.todo_item_photos;
CREATE TRIGGER todo_item_photos_max_5_total
  BEFORE INSERT OR UPDATE OF todo_id, kind, sort_order
  ON public.todo_item_photos
  FOR EACH ROW
  EXECUTE FUNCTION public._enforce_todo_item_photos_max_5_total();

REVOKE ALL ON FUNCTION public._enforce_todo_item_photos_max_5_total()
  FROM PUBLIC, anon, authenticated;

-- ── 3. Internal helpers (SECDEF-internal; no client EXECUTE) ────────────────

-- Validate a photo-path array for one item: array of DB paths scoped to the
-- task-photos bucket under todo/<todoId>/, sane filenames, max 5 in one call.
CREATE OR REPLACE FUNCTION public._todo_validate_photo_paths(
  p_todo_id text,
  p_paths   text[]
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $td_photos$
DECLARE
  v_prefix text := 'task-photos/todo/' || p_todo_id || '/';
  v_path   text;
  v_rest   text;
BEGIN
  IF p_paths IS NULL THEN
    RETURN;
  END IF;
  IF COALESCE(array_length(p_paths, 1), 0) > 5 THEN
    RAISE EXCEPTION 'TODO_VALIDATION: too many photos (% > 5)', array_length(p_paths, 1);
  END IF;
  FOREACH v_path IN ARRAY p_paths LOOP
    IF v_path IS NULL OR length(v_path) = 0 THEN
      RAISE EXCEPTION 'TODO_VALIDATION: empty photo path';
    END IF;
    IF NOT starts_with(v_path, v_prefix) THEN
      RAISE EXCEPTION 'TODO_VALIDATION: photo path % not scoped to this to do item', v_path;
    END IF;
    v_rest := substr(v_path, length(v_prefix) + 1);
    IF v_rest IS NULL OR length(v_rest) = 0
       OR position('/' in v_rest) > 0
       OR position(chr(92) in v_rest) > 0 THEN
      RAISE EXCEPTION 'TODO_VALIDATION: invalid photo filename in %', v_path;
    END IF;
  END LOOP;
END
$td_photos$;

REVOKE ALL ON FUNCTION public._todo_validate_photo_paths(text, text[]) FROM PUBLIC, anon, authenticated;

-- Insert photo rows for one item at the next free kind-scoped slots.
CREATE OR REPLACE FUNCTION public._todo_insert_photos(
  p_todo_id text,
  p_kind    text,
  p_paths   text[],
  p_actor   uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $td_insphotos$
DECLARE
  v_slot int;
  i      int;
BEGIN
  IF p_paths IS NULL OR COALESCE(array_length(p_paths, 1), 0) = 0 THEN
    RETURN;
  END IF;
  SELECT COALESCE(max(sort_order), -1) + 1
    INTO v_slot
    FROM public.todo_item_photos
   WHERE todo_id = p_todo_id AND kind = p_kind;
  FOR i IN 1 .. array_length(p_paths, 1) LOOP
    INSERT INTO public.todo_item_photos
      (id, todo_id, kind, storage_path, sort_order, uploaded_by)
    VALUES
      ('tip-' || gen_random_uuid()::text, p_todo_id, p_kind, p_paths[i], v_slot + i - 1, p_actor);
  END LOOP;
END
$td_insphotos$;

REVOKE ALL ON FUNCTION public._todo_insert_photos(text, text, text[], uuid) FROM PUBLIC, anon, authenticated;

-- Audit event insert on the todo.item entity; returns the activity event id
-- so notifications can link to it (list_recent_notifications resolves the
-- entity route through activity_event_id).
CREATE OR REPLACE FUNCTION public._todo_log_activity(
  p_todo_id    text,
  p_actor      uuid,
  p_event_type text,
  p_body       text,
  p_payload    jsonb
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $td_activity$
DECLARE
  v_ae_id text := 'ae-' || gen_random_uuid()::text;
BEGIN
  INSERT INTO public.activity_events (
    id, entity_type, entity_id, actor_profile_id, event_type, body, payload
  ) VALUES (
    v_ae_id, 'todo.item', p_todo_id, p_actor, p_event_type, p_body,
    COALESCE(p_payload, '{}'::jsonb)
  );
  RETURN v_ae_id;
END
$td_activity$;

REVOKE ALL ON FUNCTION public._todo_log_activity(text, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;

-- Creator notification on approve / reject / convert. Skips a NULL recipient
-- and self-notification (mig 057 task_completed conventions). Carries
-- activity_event_id for entity-route resolution; p_task_id is set only for
-- todo_converted so the client can route straight to the created Task.
CREATE OR REPLACE FUNCTION public._todo_notify_creator(
  p_recipient   uuid,
  p_actor       uuid,
  p_type        text,
  p_todo_id     text,
  p_todo_title  text,
  p_body        text,
  p_activity_id text,
  p_task_id     text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $td_notify$
DECLARE
  v_actor_name text;
  v_title      text;
BEGIN
  IF p_recipient IS NULL OR p_recipient = p_actor THEN
    RETURN;
  END IF;

  SELECT COALESCE(full_name, '') INTO v_actor_name
    FROM public.profiles WHERE id = p_actor;
  IF v_actor_name IS NULL OR length(btrim(v_actor_name)) = 0 THEN
    v_actor_name := 'Someone';
  END IF;

  v_title := CASE p_type
    WHEN 'todo_completion_approved' THEN v_actor_name || ' approved your to do: ' || p_todo_title
    WHEN 'todo_completion_rejected' THEN v_actor_name || ' rejected a completion on your to do: ' || p_todo_title
    WHEN 'todo_converted' THEN v_actor_name || ' converted your to do into a task: ' || p_todo_title
    ELSE v_actor_name || ' updated your to do: ' || p_todo_title
  END;

  INSERT INTO public.notifications
    (id, recipient_profile_id, actor_profile_id, type,
     task_instance_id, activity_event_id, title, body, created_at)
  VALUES
    ('ntf-' || gen_random_uuid()::text, p_recipient, p_actor, p_type,
     p_task_id, p_activity_id, v_title, left(COALESCE(p_body, ''), 200), now());
END
$td_notify$;

REVOKE ALL ON FUNCTION public._todo_notify_creator(uuid, uuid, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;

-- One item -> jsonb summary (single source for RPC return shapes).
CREATE OR REPLACE FUNCTION public._todo_item_summary(p_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $td_summary$
DECLARE
  v_out jsonb;
BEGIN
  SELECT jsonb_build_object(
    'id', t.id,
    'title', t.title,
    'description', t.description,
    'section', t.section,
    'status', t.status,
    'sort_order', t.sort_order,
    'due_date', t.due_date,
    'created_by', t.created_by,
    'created_by_name', COALESCE(cp.full_name, 'Unknown user'),
    'created_at', t.created_at,
    'updated_at', t.updated_at,
    'completion_submitted_by', t.completion_submitted_by,
    'completion_submitted_by_name', sp.full_name,
    'completion_submitted_at', t.completion_submitted_at,
    'completion_note', t.completion_note,
    'approved_by', t.approved_by,
    'approved_by_name', ap.full_name,
    'approved_at', t.approved_at,
    'rejected_by', t.rejected_by,
    'rejected_by_name', rp.full_name,
    'rejected_at', t.rejected_at,
    'rejection_note', t.rejection_note,
    'converted_task_id', t.converted_task_id,
    'photos', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', ph.id,
        'kind', ph.kind,
        'storage_path', ph.storage_path,
        'sort_order', ph.sort_order,
        'uploaded_by', ph.uploaded_by
      ) ORDER BY ph.kind, ph.sort_order), '[]'::jsonb)
      FROM public.todo_item_photos ph
      WHERE ph.todo_id = t.id
    )
  )
  INTO v_out
  FROM public.todo_items t
  LEFT JOIN public.profiles cp ON cp.id = t.created_by
  LEFT JOIN public.profiles sp ON sp.id = t.completion_submitted_by
  LEFT JOIN public.profiles ap ON ap.id = t.approved_by
  LEFT JOIN public.profiles rp ON rp.id = t.rejected_by
  WHERE t.id = p_id;

  RETURN v_out;
END
$td_summary$;

REVOKE ALL ON FUNCTION public._todo_item_summary(text) FROM PUBLIC, anon, authenticated;

-- ── 4. create_todo_item ─────────────────────────────────────────────────────
-- Any To Do participant. Replay-idempotent by id. New items append at the
-- BOTTOM of their section (manual priority above them is preserved; the
-- days-since-listed cue keeps fresh items visible).

CREATE OR REPLACE FUNCTION public.create_todo_item(
  p_id          text,
  p_title       text,
  p_description text DEFAULT NULL,
  p_section     text DEFAULT 'general',
  p_due_date    date DEFAULT NULL,
  p_photo_paths text[] DEFAULT '{}'::text[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $td_create$
DECLARE
  v_caller uuid := auth.uid();
  v_role   text;
  v_sort   int;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'create_todo_item: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('light', 'farm_team', 'management', 'admin') THEN
    RAISE EXCEPTION 'TODO_VALIDATION: caller role % cannot use the to do list', COALESCE(v_role, 'null');
  END IF;

  -- Replay idempotency: same id landing twice returns the existing summary.
  IF EXISTS (SELECT 1 FROM public.todo_items WHERE id = p_id) THEN
    RETURN public._todo_item_summary(p_id) || jsonb_build_object('replayed', true);
  END IF;

  IF p_id IS NULL OR length(btrim(p_id)) = 0 THEN
    RAISE EXCEPTION 'TODO_VALIDATION: item id required';
  END IF;
  IF p_id !~ '^[A-Za-z0-9-]+$' OR length(p_id) > 100 THEN
    RAISE EXCEPTION 'TODO_VALIDATION: invalid item id';
  END IF;
  IF p_title IS NULL OR length(btrim(p_title)) < 3 THEN
    RAISE EXCEPTION 'TODO_VALIDATION: title must be at least 3 characters';
  END IF;
  IF length(p_title) > 200 THEN
    RAISE EXCEPTION 'TODO_VALIDATION: title too long (max 200)';
  END IF;
  IF p_description IS NOT NULL AND length(p_description) > 4000 THEN
    RAISE EXCEPTION 'TODO_VALIDATION: description too long (max 4000)';
  END IF;
  IF p_section IS NULL OR p_section NOT IN ('general', 'chicken_pigs', 'cattle_sheep') THEN
    RAISE EXCEPTION 'TODO_VALIDATION: unknown section %', COALESCE(p_section, 'null');
  END IF;

  PERFORM public._todo_validate_photo_paths(p_id, p_photo_paths);

  -- Serialize section-order writers (create/update-section/reorder/move) so
  -- two concurrent creates cannot mint the same bottom slot.
  PERFORM pg_advisory_xact_lock(hashtext('todo_items_order'), hashtext(p_section));

  SELECT COALESCE(max(sort_order), -1) + 1
    INTO v_sort
    FROM public.todo_items
   WHERE section = p_section AND status IN ('open', 'pending_approval');

  INSERT INTO public.todo_items
    (id, title, description, section, status, sort_order, due_date, created_by)
  VALUES
    (p_id, btrim(p_title), NULLIF(btrim(COALESCE(p_description, '')), ''), p_section,
     'open', v_sort, p_due_date, v_caller);

  PERFORM public._todo_insert_photos(p_id, 'origination', p_photo_paths, v_caller);

  PERFORM public._todo_log_activity(
    p_id, v_caller, 'record.created',
    'Added to do: ' || btrim(p_title),
    jsonb_build_object('entity_label', btrim(p_title), 'section', p_section));

  RETURN public._todo_item_summary(p_id) || jsonb_build_object('replayed', false);
END
$td_create$;

REVOKE ALL ON FUNCTION public.create_todo_item(text, text, text, text, date, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_todo_item(text, text, text, text, date, text[]) TO authenticated;

-- ── 5. list_todo_items ──────────────────────────────────────────────────────
-- Returns every open/pending item (section order) plus the completed section
-- (newest approved first). converted/removed items are NEVER returned: the
-- To Do UI shows no converted history by design.

CREATE OR REPLACE FUNCTION public.list_todo_items(
  p_include_completed boolean DEFAULT true
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $td_list$
DECLARE
  v_caller    uuid := auth.uid();
  v_role      text;
  v_active    jsonb;
  v_completed jsonb := '[]'::jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'list_todo_items: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('light', 'farm_team', 'management', 'admin') THEN
    RAISE EXCEPTION 'TODO_VALIDATION: caller role % cannot read the to do list', COALESCE(v_role, 'null');
  END IF;

  SELECT COALESCE(jsonb_agg(public._todo_item_summary(t.id)
           ORDER BY t.section, t.sort_order, t.created_at), '[]'::jsonb)
    INTO v_active
    FROM public.todo_items t
   WHERE t.status IN ('open', 'pending_approval');

  IF COALESCE(p_include_completed, true) THEN
    SELECT COALESCE(jsonb_agg(public._todo_item_summary(t.id)
             ORDER BY t.approved_at DESC NULLS LAST, t.id DESC), '[]'::jsonb)
      INTO v_completed
      FROM public.todo_items t
     WHERE t.status = 'completed';
  END IF;

  RETURN jsonb_build_object('items', v_active, 'completed', v_completed);
END
$td_list$;

REVOKE ALL ON FUNCTION public.list_todo_items(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_todo_items(boolean) TO authenticated;

-- ── 6. update_todo_item ─────────────────────────────────────────────────────
-- open items: creator or management/admin. pending_approval/completed items:
-- management/admin only. converted/removed: nobody. A section change
-- re-appends the item at the bottom of the target section.

CREATE OR REPLACE FUNCTION public.update_todo_item(
  p_id             text,
  p_title          text DEFAULT NULL,
  p_description    text DEFAULT NULL,
  p_section        text DEFAULT NULL,
  p_due_date       date DEFAULT NULL,
  p_clear_due_date boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $td_update$
DECLARE
  v_caller  uuid := auth.uid();
  v_role    text;
  v_row     public.todo_items%ROWTYPE;
  v_manager boolean;
  v_sort    int;
  v_changed jsonb := '{}'::jsonb;
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

REVOKE ALL ON FUNCTION public.update_todo_item(text, text, text, text, date, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_todo_item(text, text, text, text, date, boolean) TO authenticated;

-- ── 7. submit_todo_completion ───────────────────────────────────────────────
-- Any To Do participant. management/admin submissions auto-approve straight
-- to completed; everyone else lands in pending_approval awaiting a manager.
-- Idempotent retry: a pending re-submit by the same submitter returns ok.

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

    PERFORM public._todo_log_activity(
      p_id, v_caller, 'todo.completion_submitted',
      'Submitted completion for to do: ' || v_row.title,
      jsonb_build_object(
        'entity_label', v_row.title,
        'completion_note', NULLIF(btrim(COALESCE(p_note, '')), '')));
  END IF;

  RETURN public._todo_item_summary(p_id) || jsonb_build_object('replayed', false);
END
$td_complete$;

REVOKE ALL ON FUNCTION public.submit_todo_completion(text, text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_todo_completion(text, text, text[]) TO authenticated;

-- ── 8. approve_todo_completion ──────────────────────────────────────────────
-- management/admin only; pending_approval -> completed; notifies the creator.

CREATE OR REPLACE FUNCTION public.approve_todo_completion(
  p_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $td_approve$
DECLARE
  v_caller uuid := auth.uid();
  v_role   text;
  v_row    public.todo_items%ROWTYPE;
  v_ae_id  text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'approve_todo_completion: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('management', 'admin') THEN
    RAISE EXCEPTION 'TODO_VALIDATION: caller role % cannot approve completions', COALESCE(v_role, 'null');
  END IF;

  SELECT * INTO v_row FROM public.todo_items WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TODO_VALIDATION: item % not found', p_id;
  END IF;
  IF v_row.status = 'completed' THEN
    RETURN public._todo_item_summary(p_id) || jsonb_build_object('replayed', true);
  END IF;
  IF v_row.status <> 'pending_approval' THEN
    RAISE EXCEPTION 'TODO_VALIDATION: item % has no pending completion (status %)', p_id, v_row.status;
  END IF;

  UPDATE public.todo_items
     SET status = 'completed',
         approved_by = v_caller,
         approved_at = now(),
         rejected_by = NULL,
         rejected_at = NULL,
         rejection_note = NULL,
         updated_at = now()
   WHERE id = p_id;

  v_ae_id := public._todo_log_activity(
    p_id, v_caller, 'todo.completion_approved',
    'Approved completion of to do: ' || v_row.title,
    jsonb_build_object(
      'entity_label', v_row.title,
      'completion_note', v_row.completion_note,
      'submitted_by', v_row.completion_submitted_by));

  PERFORM public._todo_notify_creator(
    v_row.created_by, v_caller, 'todo_completion_approved',
    p_id, v_row.title, COALESCE(v_row.completion_note, 'Completed.'), v_ae_id);

  RETURN public._todo_item_summary(p_id) || jsonb_build_object('replayed', false);
END
$td_approve$;

REVOKE ALL ON FUNCTION public.approve_todo_completion(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_todo_completion(text) TO authenticated;

-- ── 9. reject_todo_completion ───────────────────────────────────────────────
-- management/admin only; pending_approval -> open with a required short
-- rejection note. The submitted completion note/photos remain in item history:
-- the Activity event preserves the note, and completion photos stay attached
-- (they count toward the 5-photo total).

CREATE OR REPLACE FUNCTION public.reject_todo_completion(
  p_id   text,
  p_note text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $td_reject$
DECLARE
  v_caller uuid := auth.uid();
  v_role   text;
  v_row    public.todo_items%ROWTYPE;
  v_ae_id  text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'reject_todo_completion: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('management', 'admin') THEN
    RAISE EXCEPTION 'TODO_VALIDATION: caller role % cannot reject completions', COALESCE(v_role, 'null');
  END IF;

  IF p_note IS NULL OR length(btrim(p_note)) = 0 THEN
    RAISE EXCEPTION 'TODO_VALIDATION: a short rejection note is required';
  END IF;
  IF length(p_note) > 500 THEN
    RAISE EXCEPTION 'TODO_VALIDATION: rejection note too long (max 500)';
  END IF;

  SELECT * INTO v_row FROM public.todo_items WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TODO_VALIDATION: item % not found', p_id;
  END IF;
  IF v_row.status <> 'pending_approval' THEN
    RAISE EXCEPTION 'TODO_VALIDATION: item % has no pending completion (status %)', p_id, v_row.status;
  END IF;

  UPDATE public.todo_items
     SET status = 'open',
         completion_submitted_by = NULL,
         completion_submitted_at = NULL,
         completion_note = NULL,
         rejected_by = v_caller,
         rejected_at = now(),
         rejection_note = btrim(p_note),
         updated_at = now()
   WHERE id = p_id;

  v_ae_id := public._todo_log_activity(
    p_id, v_caller, 'todo.completion_rejected',
    'Rejected completion of to do: ' || v_row.title,
    jsonb_build_object(
      'entity_label', v_row.title,
      'rejection_note', btrim(p_note),
      'completion_note', v_row.completion_note,
      'submitted_by', v_row.completion_submitted_by));

  PERFORM public._todo_notify_creator(
    v_row.created_by, v_caller, 'todo_completion_rejected',
    p_id, v_row.title, btrim(p_note), v_ae_id);

  RETURN public._todo_item_summary(p_id) || jsonb_build_object('replayed', false);
END
$td_reject$;

REVOKE ALL ON FUNCTION public.reject_todo_completion(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_todo_completion(text, text) TO authenticated;

-- ── 10. reorder_todo_items ──────────────────────────────────────────────────
-- management/admin only. The client sends the FULL ordered id list for one
-- section's active (open/pending) items; sort_order becomes array position.
-- Pure priority shuffle: no Activity event (cosmetic ordering, not audit).

CREATE OR REPLACE FUNCTION public.reorder_todo_items(
  p_section     text,
  p_ordered_ids text[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $td_reorder$
DECLARE
  v_caller   uuid := auth.uid();
  v_role     text;
  v_expected int;
  v_distinct int;
  v_matching int;
  i          int;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'reorder_todo_items: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('management', 'admin') THEN
    RAISE EXCEPTION 'TODO_VALIDATION: caller role % cannot reorder the to do list', COALESCE(v_role, 'null');
  END IF;

  IF p_section IS NULL OR p_section NOT IN ('general', 'chicken_pigs', 'cattle_sheep') THEN
    RAISE EXCEPTION 'TODO_VALIDATION: unknown section %', COALESCE(p_section, 'null');
  END IF;
  IF p_ordered_ids IS NULL OR COALESCE(array_length(p_ordered_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'TODO_VALIDATION: ordered id list required';
  END IF;

  -- Serialize section-order writers (create/update-section/reorder/move).
  PERFORM pg_advisory_xact_lock(hashtext('todo_items_order'), hashtext(p_section));

  SELECT count(*) INTO v_expected
    FROM public.todo_items
   WHERE section = p_section AND status IN ('open', 'pending_approval');

  SELECT count(DISTINCT u.id) INTO v_distinct FROM unnest(p_ordered_ids) AS u(id);
  IF v_distinct <> array_length(p_ordered_ids, 1) THEN
    RAISE EXCEPTION 'TODO_VALIDATION: duplicate ids in ordered list';
  END IF;

  SELECT count(*) INTO v_matching
    FROM public.todo_items t
   WHERE t.section = p_section
     AND t.status IN ('open', 'pending_approval')
     AND t.id = ANY(p_ordered_ids);

  IF v_matching <> v_expected OR v_expected <> array_length(p_ordered_ids, 1) THEN
    RAISE EXCEPTION 'TODO_VALIDATION: ordered list does not match the section''s active items (stale list? reload and retry)';
  END IF;

  -- The active-section predicate keeps a row that concurrently left this
  -- section/active set (move/edit/approve in another session) from being
  -- stamped with a stale position; a zero-row update means the caller's list
  -- went stale mid-flight, so abort and let the client reload.
  FOR i IN 1 .. array_length(p_ordered_ids, 1) LOOP
    UPDATE public.todo_items
       SET sort_order = i - 1, updated_at = now()
     WHERE id = p_ordered_ids[i]
       AND section = p_section
       AND status IN ('open', 'pending_approval');
    GET DIAGNOSTICS v_matching = ROW_COUNT;
    IF v_matching = 0 THEN
      RAISE EXCEPTION 'TODO_VALIDATION: ordered list does not match the section''s active items (stale list? reload and retry)';
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'section', p_section, 'count', v_expected);
END
$td_reorder$;

REVOKE ALL ON FUNCTION public.reorder_todo_items(text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reorder_todo_items(text, text[]) TO authenticated;

-- ── 11. move_todo_item ──────────────────────────────────────────────────────
-- management/admin only. Moves an active item to another section, inserting at
-- p_position (0-based; NULL = bottom). The whole target section's active list
-- is renumbered 0..n-1 with the item spliced in at the clamped position —
-- count math against raw sort_order would misplace the item once values go
-- sparse (approve/convert/remove vacate slots without compaction). Section
-- moves are audited.

CREATE OR REPLACE FUNCTION public.move_todo_item(
  p_id       text,
  p_section  text,
  p_position int DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $td_move$
DECLARE
  v_caller uuid := auth.uid();
  v_role   text;
  v_row    public.todo_items%ROWTYPE;
  v_ids    text[];
  v_count  int;
  v_pos    int;
  i        int;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'move_todo_item: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('management', 'admin') THEN
    RAISE EXCEPTION 'TODO_VALIDATION: caller role % cannot move to do items', COALESCE(v_role, 'null');
  END IF;

  IF p_section IS NULL OR p_section NOT IN ('general', 'chicken_pigs', 'cattle_sheep') THEN
    RAISE EXCEPTION 'TODO_VALIDATION: unknown section %', COALESCE(p_section, 'null');
  END IF;

  SELECT * INTO v_row FROM public.todo_items WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TODO_VALIDATION: item % not found', p_id;
  END IF;
  IF v_row.status NOT IN ('open', 'pending_approval') THEN
    RAISE EXCEPTION 'TODO_VALIDATION: item % is not active (status %)', p_id, v_row.status;
  END IF;

  -- Serialize section-order writers (create/update-section/reorder/move).
  PERFORM pg_advisory_xact_lock(hashtext('todo_items_order'), hashtext(p_section));

  -- Ordered active list of the TARGET section, excluding the moved item.
  SELECT COALESCE(array_agg(t.id ORDER BY t.sort_order, t.created_at), ARRAY[]::text[])
    INTO v_ids
    FROM public.todo_items t
   WHERE t.section = p_section
     AND t.status IN ('open', 'pending_approval')
     AND t.id <> p_id;

  v_count := COALESCE(array_length(v_ids, 1), 0);
  v_pos := LEAST(GREATEST(COALESCE(p_position, v_count), 0), v_count);

  UPDATE public.todo_items
     SET section = p_section, updated_at = now()
   WHERE id = p_id;

  -- Splice the moved id in at the clamped position and renumber 0..n-1.
  v_ids := v_ids[1:v_pos] || ARRAY[p_id] || v_ids[v_pos + 1:];
  FOR i IN 1 .. array_length(v_ids, 1) LOOP
    UPDATE public.todo_items
       SET sort_order = i - 1, updated_at = now()
     WHERE id = v_ids[i];
  END LOOP;

  IF v_row.section IS DISTINCT FROM p_section THEN
    PERFORM public._todo_log_activity(
      p_id, v_caller, 'record.updated',
      'Moved to do to ' || CASE p_section
        WHEN 'general' THEN 'General'
        WHEN 'chicken_pigs' THEN 'Chicken & Pigs'
        ELSE 'Cattle & Sheep' END || ': ' || v_row.title,
      jsonb_build_object(
        'entity_label', v_row.title,
        'from_section', v_row.section,
        'to_section', p_section));
  END IF;

  RETURN public._todo_item_summary(p_id);
END
$td_move$;

REVOKE ALL ON FUNCTION public.move_todo_item(text, text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.move_todo_item(text, text, int) TO authenticated;

-- ── 12. convert_todo_item ───────────────────────────────────────────────────
-- management/admin only. Creates a REAL assigned task through the mig 053
-- create_one_time_task_instance RPC (full validation/idempotency reuse) and
-- marks the To Do converted in the same transaction. Only an OPEN item can be
-- converted: a pending completion must be approved or rejected first so a
-- submitted claim is never silently discarded. Carried origination photos are
-- client-copied into task-request-photos/<taskId>/ BEFORE this call and ride
-- in p_creation_photo_paths.

CREATE OR REPLACE FUNCTION public.convert_todo_item(
  p_id                   text,
  p_task                 jsonb,
  p_creation_photo_paths text[] DEFAULT '{}'::text[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $td_convert$
DECLARE
  v_caller  uuid := auth.uid();
  v_role    text;
  v_row     public.todo_items%ROWTYPE;
  v_result  jsonb;
  v_task_id text;
  v_ae_id   text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'convert_todo_item: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('management', 'admin') THEN
    RAISE EXCEPTION 'TODO_VALIDATION: caller role % cannot convert to do items', COALESCE(v_role, 'null');
  END IF;

  SELECT * INTO v_row FROM public.todo_items WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TODO_VALIDATION: item % not found', p_id;
  END IF;
  IF v_row.status = 'converted' AND v_row.converted_task_id IS NOT NULL THEN
    -- Idempotent retry after a network drop: the task already exists.
    RETURN jsonb_build_object('ok', true, 'replayed', true,
      'todo_id', p_id, 'task_instance_id', v_row.converted_task_id);
  END IF;
  IF v_row.status <> 'open' THEN
    RAISE EXCEPTION 'TODO_VALIDATION: only an open item can be converted (status %); approve or reject the pending completion first', v_row.status;
  END IF;

  -- Full task validation, creator stamping, and csid idempotency live in the
  -- mig 053 RPC; a validation failure there aborts this whole transaction, so
  -- the To Do stays open unchanged.
  v_result := public.create_one_time_task_instance(p_task, COALESCE(p_creation_photo_paths, '{}'::text[]));
  v_task_id := v_result->>'instance_id';
  IF v_task_id IS NULL OR length(v_task_id) = 0 THEN
    RAISE EXCEPTION 'TODO_VALIDATION: task creation did not return an instance id';
  END IF;
  -- A first-time convert can never legitimately replay: a committed prior
  -- convert is caught by the status='converted' early-return above, and an
  -- aborted one rolled its csid back. idempotent_replay=true here means the
  -- csid belongs to a task created by some OTHER flow — abort rather than
  -- silently link this To Do to an unrelated task.
  IF COALESCE((v_result->>'idempotent_replay')::boolean, false) THEN
    RAISE EXCEPTION 'TODO_VALIDATION: task id was already used by another task; reopen the convert form and retry';
  END IF;

  UPDATE public.todo_items
     SET status = 'converted',
         converted_task_id = v_task_id,
         converted_by = v_caller,
         converted_at = now(),
         updated_at = now()
   WHERE id = p_id;

  v_ae_id := public._todo_log_activity(
    p_id, v_caller, 'record.converted',
    'Converted to do into task: ' || v_row.title,
    jsonb_build_object(
      'entity_label', v_row.title,
      'task_instance_id', v_task_id));

  PERFORM public._todo_notify_creator(
    v_row.created_by, v_caller, 'todo_converted',
    p_id, v_row.title, 'Now assigned as a task.', v_ae_id, v_task_id);

  RETURN jsonb_build_object('ok', true, 'replayed', false,
    'todo_id', p_id, 'task_instance_id', v_task_id);
END
$td_convert$;

REVOKE ALL ON FUNCTION public.convert_todo_item(text, jsonb, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convert_todo_item(text, jsonb, text[]) TO authenticated;

-- ── 13. remove_todo_item ────────────────────────────────────────────────────
-- management/admin only; open/pending -> removed (soft, audited, hidden from
-- every To Do list view; Activity history persists on the entity).

CREATE OR REPLACE FUNCTION public.remove_todo_item(
  p_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $td_remove$
DECLARE
  v_caller uuid := auth.uid();
  v_role   text;
  v_row    public.todo_items%ROWTYPE;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'remove_todo_item: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('management', 'admin') THEN
    RAISE EXCEPTION 'TODO_VALIDATION: caller role % cannot remove to do items', COALESCE(v_role, 'null');
  END IF;

  SELECT * INTO v_row FROM public.todo_items WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TODO_VALIDATION: item % not found', p_id;
  END IF;
  IF v_row.status = 'removed' THEN
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'id', p_id);
  END IF;
  IF v_row.status NOT IN ('open', 'pending_approval') THEN
    RAISE EXCEPTION 'TODO_VALIDATION: item % cannot be removed (status %)', p_id, v_row.status;
  END IF;

  UPDATE public.todo_items
     SET status = 'removed',
         removed_by = v_caller,
         removed_at = now(),
         updated_at = now()
   WHERE id = p_id;

  PERFORM public._todo_log_activity(
    p_id, v_caller, 'record.removed',
    'Removed to do: ' || v_row.title,
    jsonb_build_object('entity_label', v_row.title, 'prior_status', v_row.status));

  RETURN jsonb_build_object('ok', true, 'replayed', false, 'id', p_id);
END
$td_remove$;

REVOKE ALL ON FUNCTION public.remove_todo_item(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_todo_item(text) TO authenticated;

-- ── 14. notifications type CHECK: add the three todo types ──────────────────

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('task_completed', 'mention', 'comment_mention',
                  'todo_completion_approved', 'todo_completion_rejected',
                  'todo_converted'));

-- ── 15. task_summary_runs: todo digest accounting column ────────────────────

ALTER TABLE public.task_summary_runs
  ADD COLUMN IF NOT EXISTS total_todo_items int NOT NULL DEFAULT 0;

-- ── 16. _activity_can_read: add 'todo.item' branch ──────────────────────────
-- Faithful re-issue of the LATEST definition (mig 112) preserving every
-- existing branch (incl. cattle.log), adding the todo.item branch before the
-- fail-closed default: row existence + EXPLICIT role gate (light/farm_team/
-- management/admin). equipment_tech and inactive have no access.

CREATE OR REPLACE FUNCTION public._activity_can_read(
  p_entity_type text,
  p_entity_id   text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $can_read$
DECLARE
  v_role    text;
  v_access  text[];
  v_species text;
BEGIN
  IF p_entity_type IS NULL OR length(trim(p_entity_type)) = 0 THEN
    RETURN false;
  END IF;
  IF p_entity_id IS NULL OR length(trim(p_entity_id)) = 0 THEN
    RETURN false;
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL THEN
    RETURN false;
  END IF;
  IF v_role = 'inactive' THEN
    RETURN false;
  END IF;

  -- ── Task entity types: transparency RLS, no program_access ──────────

  IF p_entity_type = 'task.instance' THEN
    IF NOT EXISTS (SELECT 1 FROM public.task_instances WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    RETURN true;
  END IF;

  IF p_entity_type = 'task.template' THEN
    IF NOT EXISTS (SELECT 1 FROM public.task_templates WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    RETURN true;
  END IF;

  IF p_entity_type = 'task.system_rule' THEN
    IF NOT EXISTS (SELECT 1 FROM public.task_system_rules WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    RETURN true;
  END IF;

  -- ── Non-task: existence + program_access. Admin bypasses program. ───

  IF p_entity_type = 'broiler.batch' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.app_store
      WHERE key = 'ppp-v4'
        AND data::jsonb @> jsonb_build_array(jsonb_build_object('name', p_entity_id))
    ) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'broiler' = ANY(v_access);
  END IF;

  IF p_entity_type = 'pig.batch' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.app_store
      WHERE key = 'ppp-feeders-v1'
        AND data::jsonb @> jsonb_build_array(jsonb_build_object('id', p_entity_id))
    ) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'pig' = ANY(v_access);
  END IF;

  IF p_entity_type = 'layer.batch' THEN
    IF NOT EXISTS (SELECT 1 FROM public.layer_batches WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'layer' = ANY(v_access);
  END IF;

  IF p_entity_type = 'layer.housing' THEN
    IF NOT EXISTS (SELECT 1 FROM public.layer_housings WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'layer' = ANY(v_access);
  END IF;

  IF p_entity_type = 'cattle.animal' THEN
    IF NOT EXISTS (SELECT 1 FROM public.cattle WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'cattle' = ANY(v_access);
  END IF;

  IF p_entity_type = 'cattle.processing' THEN
    IF NOT EXISTS (SELECT 1 FROM public.cattle_processing_batches WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'cattle' = ANY(v_access);
  END IF;

  -- ── Custom editable-table Activity: cattle forecast workflow ──────────
  -- Singleton workflow entity (entity_id 'cattle-forecast'); no per-row
  -- existence check. Gated on cattle program access like cattle.animal.

  IF p_entity_type = 'cattle.forecast' THEN
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'cattle' = ANY(v_access);
  END IF;

  -- Custom editable-table Activity: cattle breeding-cycle workflow.
  -- Singleton workflow entity (entity_id 'cattle-breeding'); no per-row
  -- existence check. Gated on cattle program access like cattle.forecast.

  IF p_entity_type = 'cattle.breeding' THEN
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'cattle' = ANY(v_access);
  END IF;

  IF p_entity_type = 'sheep.animal' THEN
    IF NOT EXISTS (SELECT 1 FROM public.sheep WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'sheep' = ANY(v_access);
  END IF;

  IF p_entity_type = 'sheep.processing' THEN
    IF NOT EXISTS (SELECT 1 FROM public.sheep_processing_batches WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'sheep' = ANY(v_access);
  END IF;

  IF p_entity_type = 'equipment.item' THEN
    IF NOT EXISTS (SELECT 1 FROM public.equipment WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'equipment' = ANY(v_access);
  END IF;

  -- ── Daily report entity types ─────────────────────────────────────────
  -- Existence check does NOT filter deleted_at so soft-deleted rows remain
  -- resolver-visible and their Activity events stay accessible in /activity.

  IF p_entity_type = 'poultry.daily' THEN
    IF NOT EXISTS (SELECT 1 FROM public.poultry_dailys WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'broiler' = ANY(v_access);
  END IF;

  IF p_entity_type = 'layer.daily' THEN
    IF NOT EXISTS (SELECT 1 FROM public.layer_dailys WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'layer' = ANY(v_access);
  END IF;

  IF p_entity_type = 'egg.daily' THEN
    IF NOT EXISTS (SELECT 1 FROM public.egg_dailys WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'layer' = ANY(v_access);
  END IF;

  IF p_entity_type = 'pig.daily' THEN
    IF NOT EXISTS (SELECT 1 FROM public.pig_dailys WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'pig' = ANY(v_access);
  END IF;

  IF p_entity_type = 'cattle.daily' THEN
    IF NOT EXISTS (SELECT 1 FROM public.cattle_dailys WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'cattle' = ANY(v_access);
  END IF;

  IF p_entity_type = 'sheep.daily' THEN
    IF NOT EXISTS (SELECT 1 FROM public.sheep_dailys WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'sheep' = ANY(v_access);
  END IF;

  -- ── Weigh-in session entity type ──────────────────────────────────────
  -- Species-specific program_access gate: reads weigh_in_sessions.species
  -- to determine which program to check (cattle/sheep/pig/broiler).

  IF p_entity_type = 'weighin.session' THEN
    SELECT species INTO v_species
    FROM public.weigh_in_sessions
    WHERE id = p_entity_id;
    IF v_species IS NULL THEN
      RETURN false;
    END IF;
    IF v_species NOT IN ('cattle', 'sheep', 'pig', 'broiler') THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN v_species = ANY(v_access);
  END IF;

  -- ── Cattle Log singleton entity (mig 112) ─────────────────────────────
  -- Explicit role gate, NOT profile_program_access: light, farm_team,
  -- management, admin only. equipment_tech (and inactive, filtered above)
  -- have no access.

  IF p_entity_type = 'cattle.log' THEN
    RETURN v_role IN ('light', 'farm_team', 'management', 'admin');
  END IF;

  -- ── To Do item entity (mig 115) ───────────────────────────────────────
  -- Row existence + explicit role gate, NOT profile_program_access: light,
  -- farm_team, management, admin only. equipment_tech (and inactive,
  -- filtered above) have no To Do access. Existence does NOT filter status:
  -- completed/converted/removed items keep their Activity readable.

  IF p_entity_type = 'todo.item' THEN
    IF NOT EXISTS (SELECT 1 FROM public.todo_items WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    RETURN v_role IN ('light', 'farm_team', 'management', 'admin');
  END IF;

  -- Unknown entity_type. Fail closed.
  RETURN false;
END
$can_read$;

REVOKE ALL ON FUNCTION public._activity_can_read(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._activity_can_read(text, text) TO authenticated;

-- ── 17. _activity_can_write: faithful re-issue (comment update only) ────────
-- Verbatim mig 112 behavior. todo.item deliberately has NO branch here: the
-- can_read delegation lets the generic comment RPCs (post_comment/
-- edit_comment/delete_comment) serve To Do record-page discussion for the
-- same role set, unlike cattle.log whose entries are RPC-managed.

CREATE OR REPLACE FUNCTION public._activity_can_write(
  p_entity_type text,
  p_entity_id   text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $can_write$
DECLARE
  v_role text := public.profile_role();
BEGIN
  IF v_role IS NULL OR v_role = 'inactive' THEN
    RETURN false;
  END IF;

  -- Cattle Log singleton entity (mig 112): writes to cattle.log go
  -- exclusively through the Cattle Log RPC family (submit/edit/
  -- delete_cattle_log_entry), which carries its own explicit role gate.
  -- Generic comment writes (post_comment et al.) are always refused so tag
  -- parsing / issue state can never be bypassed. Reads stay role-gated in
  -- _activity_can_read.
  IF p_entity_type = 'cattle.log' THEN
    RETURN false;
  END IF;

  -- todo.item (mig 115) intentionally has NO branch: generic comments are
  -- the To Do record page's discussion surface and delegate to the role-
  -- gated existence check in _activity_can_read.
  RETURN public._activity_can_read(p_entity_type, p_entity_id);
END
$can_write$;

REVOKE ALL ON FUNCTION public._activity_can_write(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._activity_can_write(text, text) TO authenticated;

-- ── 18. list_todo_mentionable_profiles ──────────────────────────────────────
-- To Do record-page comments use the generic comment RPCs, but the To Do
-- mention picker must be NARROWER than list_comment_mentionable_profiles
-- (which includes equipment_tech): a To Do is only readable by light/
-- farm_team/management/admin, so only those roles may be mention targets.
-- Mirrors list_cattle_log_mentionable_profiles (mig 112).

CREATE OR REPLACE FUNCTION public.list_todo_mentionable_profiles()
RETURNS TABLE (id uuid, full_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $td_mention$
DECLARE
  v_caller uuid := auth.uid();
  v_role   text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'list_todo_mentionable_profiles: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('light', 'farm_team', 'management', 'admin') THEN
    RAISE EXCEPTION 'TODO_VALIDATION: caller role % cannot use the to do list', COALESCE(v_role, 'null');
  END IF;

  RETURN QUERY
  SELECT p.id, p.full_name
    FROM public.profiles p
   WHERE p.role IN ('light', 'farm_team', 'management', 'admin')
     AND p.full_name IS NOT NULL
     AND length(btrim(p.full_name)) > 0
   ORDER BY p.full_name;
END
$td_mention$;

REVOKE ALL ON FUNCTION public.list_todo_mentionable_profiles() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_todo_mentionable_profiles() TO authenticated;

-- ── 19. post_comment: reject non-participant mentions on todo.item ──────────
-- Faithful re-issue of the LATEST definition (mig 071; no later redefinition)
-- with ONE added guard inside the mention-validation loop: when the comment
-- is on a todo.item entity, a mentioned profile MUST be a To Do participant
-- (light/farm_team/management/admin). Without this, an equipment_tech could
-- be mentioned on a To Do they cannot read (entity gate excludes them),
-- creating a dangling notification. Behavior for every other entity_type is
-- byte-for-byte unchanged.

CREATE OR REPLACE FUNCTION public.post_comment(
  p_entity_type  text,
  p_entity_id    text,
  p_body         text,
  p_entity_label text DEFAULT NULL,
  p_mentions     uuid[] DEFAULT ARRAY[]::uuid[],
  p_attachments  jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $pc_todo$
DECLARE
  v_caller     uuid := auth.uid();
  v_role       text;
  v_comment_id text;
  v_actor_name text;
  v_label      text;
  v_m          uuid;
  v_n_mentions int;
  v_mention_role text;
  v_notif_id   text;
  v_notif_title text;
  v_notif_body text;
  v_n_attach   int;
  i            int;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'post_comment: authenticated caller required';
  END IF;
  IF p_body IS NULL OR length(trim(p_body)) = 0 THEN
    RAISE EXCEPTION 'post_comment: body required (non-empty)';
  END IF;
  IF length(p_body) > 4000 THEN
    RAISE EXCEPTION 'post_comment: body too long (% chars; max 4000)', length(p_body);
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role = 'inactive' THEN
    RAISE EXCEPTION 'post_comment: caller role % cannot post', COALESCE(v_role, 'null');
  END IF;
  IF NOT public._activity_can_write(p_entity_type, p_entity_id) THEN
    RAISE EXCEPTION 'post_comment: not permitted for entity_type=%', p_entity_type;
  END IF;

  -- Validate attachments: array, max 5, each item must have path/name/mime
  IF jsonb_typeof(p_attachments) <> 'array' THEN
    RAISE EXCEPTION 'post_comment: attachments must be a JSON array';
  END IF;
  v_n_attach := jsonb_array_length(p_attachments);
  IF v_n_attach > 5 THEN
    RAISE EXCEPTION 'post_comment: too many attachments (% > 5)', v_n_attach;
  END IF;
  FOR i IN 0 .. v_n_attach - 1 LOOP
    IF (p_attachments->i->>'path') IS NULL OR length(p_attachments->i->>'path') = 0 THEN
      RAISE EXCEPTION 'post_comment: attachment[%] missing path', i;
    END IF;
    IF NOT starts_with(p_attachments->i->>'path', p_entity_type || '/' || p_entity_id || '/') THEN
      RAISE EXCEPTION 'post_comment: attachment[%] path not scoped to entity', i;
    END IF;
    IF (p_attachments->i->>'name') IS NULL THEN
      RAISE EXCEPTION 'post_comment: attachment[%] missing name', i;
    END IF;
    IF (p_attachments->i->>'mime') IS NULL THEN
      RAISE EXCEPTION 'post_comment: attachment[%] missing mime', i;
    END IF;
  END LOOP;

  -- Validate mentions
  v_n_mentions := COALESCE(array_length(p_mentions, 1), 0);
  IF v_n_mentions > 10 THEN
    RAISE EXCEPTION 'post_comment: too many mentions (% > 10)', v_n_mentions;
  END IF;
  IF v_n_mentions > 0 THEN
    FOREACH v_m IN ARRAY p_mentions LOOP
      IF v_m = v_caller THEN
        RAISE EXCEPTION 'post_comment: cannot mention yourself';
      END IF;
      SELECT role INTO v_mention_role FROM public.profiles WHERE id = v_m;
      IF v_mention_role IS NULL THEN
        RAISE EXCEPTION 'post_comment: mentioned profile % not found', v_m;
      END IF;
      IF v_mention_role = 'inactive' THEN
        RAISE EXCEPTION 'post_comment: mentioned profile % is inactive', v_m;
      END IF;
      -- To Do scope (mig 115): only To Do participants are valid targets.
      IF p_entity_type = 'todo.item' AND v_mention_role NOT IN ('light', 'farm_team', 'management', 'admin') THEN
        RAISE EXCEPTION 'post_comment: mentioned profile % is not a To Do participant', v_m;
      END IF;
    END LOOP;
  END IF;

  SELECT COALESCE(full_name, '') INTO v_actor_name
    FROM public.profiles WHERE id = v_caller;
  IF v_actor_name IS NULL OR length(trim(v_actor_name)) = 0 THEN
    v_actor_name := 'Someone';
  END IF;

  v_label := COALESCE(NULLIF(trim(COALESCE(p_entity_label, '')), ''), p_entity_id);
  v_comment_id := 'cmt-' || gen_random_uuid()::text;

  INSERT INTO public.comments
    (id, entity_type, entity_id, author_profile_id, body, mentions, attachments, created_at)
  VALUES
    (v_comment_id, p_entity_type, p_entity_id, v_caller, p_body, p_mentions, p_attachments, now());

  -- Fan out mention notifications
  IF v_n_mentions > 0 THEN
    FOREACH v_m IN ARRAY p_mentions LOOP
      v_notif_id := 'ntf-' || gen_random_uuid()::text;
      v_notif_title := v_actor_name || ' mentioned you in a comment on ' || v_label;
      v_notif_body := left(p_body, 200);

      INSERT INTO public.notifications
        (id, recipient_profile_id, actor_profile_id, type,
         comment_entity_type, comment_entity_id, comment_entity_label,
         comment_id, title, body, created_at)
      VALUES
        (v_notif_id, v_m, v_caller, 'comment_mention',
         p_entity_type, p_entity_id, v_label,
         v_comment_id, v_notif_title, v_notif_body, now());
    END LOOP;
  END IF;

  RETURN jsonb_build_object('ok', true, 'comment_id', v_comment_id);
END
$pc_todo$;

REVOKE ALL ON FUNCTION public.post_comment(text, text, text, text, uuid[], jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_comment(text, text, text, text, uuid[], jsonb) TO authenticated;

-- ── 20. edit_comment: reject non-participant mentions on todo.item ──────────
-- Faithful re-issue of the LATEST definition (mig 112, which added the Cattle
-- Log mirror + originals guards) with the same todo.item mention guard added
-- to the mention-validation loop. Every mig 112 cattle.log clause is
-- preserved verbatim; non-todo.item behavior is unchanged.

CREATE OR REPLACE FUNCTION public.edit_comment(
  p_comment_id   text,
  p_body         text,
  p_mentions     uuid[] DEFAULT ARRAY[]::uuid[],
  p_attachments  jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $ec_todo$
DECLARE
  v_caller     uuid := auth.uid();
  v_role       text;
  v_row        record;
  v_m          uuid;
  v_n_mentions int;
  v_mention_role text;
  v_edit_id    text;
  v_actor_name text;
  v_label      text;
  v_already    boolean;
  v_notif_id   text;
  v_notif_title text;
  v_notif_body text;
  v_n_attach   int;
  i            int;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'edit_comment: authenticated caller required';
  END IF;

  -- Cattle Log mirror guard (mig 112).
  IF p_comment_id LIKE 'clog-%' OR EXISTS (
    SELECT 1 FROM public.cattle_log_tag_links
     WHERE mirror_comment_id = p_comment_id
  ) THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: cattle log mirrors are managed by the Cattle Log RPCs';
  END IF;

  IF p_body IS NULL OR length(trim(p_body)) = 0 THEN
    RAISE EXCEPTION 'edit_comment: body required (non-empty)';
  END IF;
  IF length(p_body) > 4000 THEN
    RAISE EXCEPTION 'edit_comment: body too long';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role = 'inactive' THEN
    RAISE EXCEPTION 'edit_comment: caller role % cannot edit', COALESCE(v_role, 'null');
  END IF;

  SELECT id, entity_type, entity_id, author_profile_id, body, mentions, attachments, deleted_at
    INTO v_row
    FROM public.comments
    WHERE id = p_comment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'edit_comment: comment % not found', p_comment_id;
  END IF;
  IF v_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'edit_comment: comment % is deleted', p_comment_id;
  END IF;
  -- Cattle Log originals guard (mig 112): 'cl-…' log entries must go through
  -- edit_cattle_log_entry (tag re-diff + mirror resync).
  IF v_row.entity_type = 'cattle.log' THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: cattle log entries are managed by the Cattle Log RPCs';
  END IF;
  IF v_row.author_profile_id IS DISTINCT FROM v_caller THEN
    RAISE EXCEPTION 'edit_comment: only the author may edit';
  END IF;
  IF NOT public._activity_can_write(v_row.entity_type, v_row.entity_id) THEN
    RAISE EXCEPTION 'edit_comment: not permitted for entity';
  END IF;

  -- Validate attachments: array, max 5, each item must have path/name/mime
  IF jsonb_typeof(p_attachments) <> 'array' THEN
    RAISE EXCEPTION 'edit_comment: attachments must be a JSON array';
  END IF;
  v_n_attach := jsonb_array_length(p_attachments);
  IF v_n_attach > 5 THEN
    RAISE EXCEPTION 'edit_comment: too many attachments (% > 5)', v_n_attach;
  END IF;
  FOR i IN 0 .. v_n_attach - 1 LOOP
    IF (p_attachments->i->>'path') IS NULL OR length(p_attachments->i->>'path') = 0 THEN
      RAISE EXCEPTION 'edit_comment: attachment[%] missing path', i;
    END IF;
    IF NOT starts_with(p_attachments->i->>'path', v_row.entity_type || '/' || v_row.entity_id || '/') THEN
      RAISE EXCEPTION 'edit_comment: attachment[%] path not scoped to entity', i;
    END IF;
    IF (p_attachments->i->>'name') IS NULL THEN
      RAISE EXCEPTION 'edit_comment: attachment[%] missing name', i;
    END IF;
    IF (p_attachments->i->>'mime') IS NULL THEN
      RAISE EXCEPTION 'edit_comment: attachment[%] missing mime', i;
    END IF;
  END LOOP;

  -- Validate mentions
  v_n_mentions := COALESCE(array_length(p_mentions, 1), 0);
  IF v_n_mentions > 10 THEN
    RAISE EXCEPTION 'edit_comment: too many mentions';
  END IF;
  IF v_n_mentions > 0 THEN
    FOREACH v_m IN ARRAY p_mentions LOOP
      IF v_m = v_caller THEN
        RAISE EXCEPTION 'edit_comment: cannot mention yourself';
      END IF;
      SELECT role INTO v_mention_role FROM public.profiles WHERE id = v_m;
      IF v_mention_role IS NULL THEN
        RAISE EXCEPTION 'edit_comment: mentioned profile % not found', v_m;
      END IF;
      IF v_mention_role = 'inactive' THEN
        RAISE EXCEPTION 'edit_comment: mentioned profile % is inactive', v_m;
      END IF;
      -- To Do scope (mig 115): only To Do participants are valid targets.
      IF v_row.entity_type = 'todo.item' AND v_mention_role NOT IN ('light', 'farm_team', 'management', 'admin') THEN
        RAISE EXCEPTION 'edit_comment: mentioned profile % is not a To Do participant', v_m;
      END IF;
    END LOOP;
  END IF;

  -- Save previous version to edit history
  v_edit_id := 'cedit-' || gen_random_uuid()::text;
  INSERT INTO public.comment_edits
    (id, comment_id, previous_body, previous_attachments, edited_by, edited_at)
  VALUES
    (v_edit_id, p_comment_id, v_row.body, v_row.attachments, v_caller, now());

  UPDATE public.comments
    SET body = p_body,
        mentions = p_mentions,
        attachments = p_attachments,
        edited_at = now()
    WHERE id = p_comment_id;

  -- Fan out notifications for NEW mentions only
  IF v_n_mentions > 0 THEN
    SELECT COALESCE(full_name, '') INTO v_actor_name
      FROM public.profiles WHERE id = v_caller;
    IF v_actor_name IS NULL OR length(trim(v_actor_name)) = 0 THEN
      v_actor_name := 'Someone';
    END IF;
    v_label := COALESCE(NULLIF(trim(COALESCE(v_row.entity_id, '')), ''), p_comment_id);

    FOREACH v_m IN ARRAY p_mentions LOOP
      SELECT (v_m = ANY(v_row.mentions)) INTO v_already;
      IF v_already THEN CONTINUE; END IF;

      v_notif_id := 'ntf-' || gen_random_uuid()::text;
      v_notif_title := v_actor_name || ' mentioned you in a comment on ' || v_label;
      v_notif_body := left(p_body, 200);
      INSERT INTO public.notifications
        (id, recipient_profile_id, actor_profile_id, type,
         comment_entity_type, comment_entity_id, comment_entity_label,
         comment_id, title, body, created_at)
      VALUES
        (v_notif_id, v_m, v_caller, 'comment_mention',
         v_row.entity_type, v_row.entity_id, v_label,
         p_comment_id, v_notif_title, v_notif_body, now());
    END LOOP;
  END IF;

  RETURN jsonb_build_object('ok', true, 'comment_id', p_comment_id);
END
$ec_todo$;

REVOKE ALL ON FUNCTION public.edit_comment(text, text, uuid[], jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.edit_comment(text, text, uuid[], jsonb) TO authenticated;

-- ── 21. Reload PostgREST schema cache ───────────────────────────────────────

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- End of 115_todo_items.sql
-- ============================================================================
