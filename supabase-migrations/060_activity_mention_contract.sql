-- ============================================================================
-- 060_activity_mention_contract.sql
-- ----------------------------------------------------------------------------
-- Activity + @Mentions — switch the mention contract so the visible
-- comment body stays user-friendly ("@Nick"), and the structured mention
-- identity travels via p_mentions[] uuids only.
--
-- Why:
--   Phase 1 (mig 058) stored mentions inline as `@[Display Name](profile:
--   <uuid>)` in the body and required every p_mentions uuid to also
--   appear in that inline form. The token leaked raw uuids into the
--   visible textarea and the rendered timeline. Per Codex pre-polish
--   review: users must only ever see "@Nick" — uuids never.
--
-- Contract change (this migration):
--   * post_activity_comment / edit_activity_event — drop the
--     "every p_mentions uuid must appear in body" validation. p_mentions[]
--     is now the SOLE source of truth for who gets notified.
--     All other server validations stay in place:
--       - mentioned profile exists                   (RAISE if missing)
--       - mentioned profile is not 'inactive'        (RAISE if inactive)
--       - cap: ≤ 10 mentions per comment             (RAISE if over)
--       - caller must have _activity_can_write perm  (RAISE if no)
--       - body required + ≤ 4000 chars               (unchanged)
--       - self-mention records the mention row but does NOT fire a
--         notification (unchanged)
--   * list_activity_events — RETURNS shape gains
--     `mentioned_profile_names text[]` resolved server-side from profiles
--     so the renderer can chip "@Nick" spans without round-tripping per
--     event. Names are returned in the SAME order as mentioned_profile_ids
--     so the client can pair them.
--   * _extract_mention_uuids stays defined (might be useful for backfill
--     or admin tooling later) but is no longer called from the RPCs.
--
-- Apply order:
--   TEST first (validate with Playwright). PROD after the polish branch is
--   reviewed and approved.
--
-- Apply mechanism note:
--   Test path goes through scripts/apply_migration_test.cjs → exec_sql RPC,
--   which EXECUTE's the file body inside an outer SECDEF transaction. We
--   therefore do NOT wrap this migration in BEGIN/COMMIT — those would be
--   syntax errors inside the executor (you can't BEGIN inside a SAVEPOINT-
--   less inner block). Prod apply uses psql directly with ON_ERROR_STOP=1,
--   which still wraps the file in an implicit transaction per
--   AUTOCOMMIT-OFF behavior; that's enough atomicity for the three
--   functions being replaced.
-- ============================================================================

-- ── 1. list_activity_events — add mentioned_profile_names ────────────────
--
-- RETURNS TABLE shape gains a column → CREATE OR REPLACE refuses; drop
-- then create. The function has no dependents (the SECDEF RPCs are the
-- only callers and read result rows directly).

DROP FUNCTION IF EXISTS public.list_activity_events(text, text, int);

CREATE FUNCTION public.list_activity_events(
  p_entity_type text,
  p_entity_id   text,
  p_limit       int DEFAULT 50
) RETURNS TABLE (
  id                      text,
  entity_type             text,
  entity_id               text,
  actor_profile_id        uuid,
  actor_display_name      text,
  event_type              text,
  body                    text,
  payload                 jsonb,
  created_at              timestamptz,
  edited_at               timestamptz,
  deleted_at              timestamptz,
  mentioned_profile_ids   uuid[],
  mentioned_profile_names text[]
) LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $list_activity$
DECLARE
  v_limit int := COALESCE(p_limit, 50);
BEGIN
  IF NOT public._activity_can_read(p_entity_type, p_entity_id) THEN
    RAISE EXCEPTION 'list_activity_events: not permitted for entity_type=%', p_entity_type;
  END IF;
  IF v_limit < 1 THEN v_limit := 1; END IF;
  IF v_limit > 200 THEN v_limit := 200; END IF;

  RETURN QUERY
    SELECT
      ae.id, ae.entity_type, ae.entity_id, ae.actor_profile_id,
      -- Actor display name — table-qualified to dodge the OUT-parameter
      -- collision with the RETURNS TABLE `id` column.
      (SELECT p.full_name FROM public.profiles p WHERE p.id = ae.actor_profile_id) AS actor_display_name,
      ae.event_type, ae.body, ae.payload,
      ae.created_at, ae.edited_at, ae.deleted_at,
      -- mentioned_profile_ids — ordered by created_at so the names array
      -- below stays positionally aligned (ARRAY_AGG without ORDER is
      -- nondeterministic; here we lock it on (created_at, mentioned_id)
      -- so pairs round-trip stably).
      COALESCE(
        (SELECT array_agg(am.mentioned_profile_id ORDER BY am.created_at, am.mentioned_profile_id)
           FROM public.activity_mentions am
          WHERE am.event_id = ae.id),
        ARRAY[]::uuid[]
      ) AS mentioned_profile_ids,
      -- mentioned_profile_names — same ordering as the ids above, joined
      -- to profiles for display. NULL slots are coalesced to empty string
      -- so the client never has to handle null in the array.
      COALESCE(
        (SELECT array_agg(COALESCE(p2.full_name, '') ORDER BY am2.created_at, am2.mentioned_profile_id)
           FROM public.activity_mentions am2
           LEFT JOIN public.profiles p2 ON p2.id = am2.mentioned_profile_id
          WHERE am2.event_id = ae.id),
        ARRAY[]::text[]
      ) AS mentioned_profile_names
    FROM public.activity_events ae
    WHERE ae.entity_type = p_entity_type
      AND ae.entity_id = p_entity_id
    ORDER BY ae.created_at DESC
    LIMIT v_limit;
END
$list_activity$;

REVOKE ALL ON FUNCTION public.list_activity_events(text, text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_activity_events(text, text, int) TO authenticated;

-- ── 2. post_activity_comment — drop body-uuid validation ─────────────────
--
-- p_mentions[] is now authoritative. The visible body is freeform; only
-- the structured uuid list drives the mention rows + notifications.
-- All other validations stay in place — profile existence, inactive
-- rejection, mention cap, caller permission, body length.

CREATE OR REPLACE FUNCTION public.post_activity_comment(
  p_entity_type  text,
  p_entity_id    text,
  p_body         text,
  p_entity_label text DEFAULT NULL,
  p_mentions     uuid[] DEFAULT ARRAY[]::uuid[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $post_comment$
DECLARE
  v_caller uuid := auth.uid();
  v_event_id text;
  v_actor_name text;
  v_label text;
  v_m uuid;
  v_n_mentions int;
  v_mention_role text;
  v_notif_id text;
  v_notif_title text;
  v_notif_body text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'post_activity_comment: authenticated caller required';
  END IF;
  IF p_body IS NULL OR length(trim(p_body)) = 0 THEN
    RAISE EXCEPTION 'post_activity_comment: body required (non-empty)';
  END IF;
  IF length(p_body) > 4000 THEN
    RAISE EXCEPTION 'post_activity_comment: body too long (% chars; max 4000)', length(p_body);
  END IF;
  IF NOT public._activity_can_write(p_entity_type, p_entity_id) THEN
    RAISE EXCEPTION 'post_activity_comment: not permitted for entity_type=%', p_entity_type;
  END IF;

  v_n_mentions := COALESCE(array_length(p_mentions, 1), 0);
  IF v_n_mentions > 10 THEN
    RAISE EXCEPTION 'post_activity_comment: too many mentions (% > 10)', v_n_mentions;
  END IF;

  -- Resolve caller's display name (locked server-side).
  SELECT COALESCE(full_name, '') INTO v_actor_name
    FROM public.profiles
    WHERE id = v_caller;
  IF v_actor_name IS NULL OR length(trim(v_actor_name)) = 0 THEN
    v_actor_name := 'Someone';
  END IF;

  v_label := COALESCE(NULLIF(trim(COALESCE(p_entity_label, '')), ''), p_entity_id);

  v_event_id := 'ae-' || gen_random_uuid()::text;

  INSERT INTO public.activity_events
    (id, entity_type, entity_id, actor_profile_id, event_type, body, payload, created_at)
  VALUES
    (v_event_id, p_entity_type, p_entity_id, v_caller, 'comment.posted',
     p_body,
     jsonb_build_object('entity_label', v_label, 'mention_count', v_n_mentions),
     now());

  -- Insert mentions + fan out notifications.
  IF v_n_mentions > 0 THEN
    FOREACH v_m IN ARRAY p_mentions LOOP
      -- Verify mentioned profile exists + not inactive.
      SELECT role INTO v_mention_role FROM public.profiles WHERE id = v_m;
      IF v_mention_role IS NULL THEN
        RAISE EXCEPTION 'post_activity_comment: mentioned profile % not found', v_m;
      END IF;
      IF v_mention_role = 'inactive' THEN
        RAISE EXCEPTION 'post_activity_comment: mentioned profile % is inactive', v_m;
      END IF;

      -- Record the mention row (idempotent via PK).
      INSERT INTO public.activity_mentions (event_id, mentioned_profile_id, created_at)
      VALUES (v_event_id, v_m, now())
      ON CONFLICT (event_id, mentioned_profile_id) DO NOTHING;

      -- Self-mention: do NOT create a notification. The mention row is
      -- still recorded so the renderer can highlight the @name in the
      -- comment body.
      IF v_m = v_caller THEN
        CONTINUE;
      END IF;

      v_notif_id := 'ntf-' || gen_random_uuid()::text;
      v_notif_title := v_actor_name || ' mentioned you on ' || v_label;
      v_notif_body := left(p_body, 200);

      INSERT INTO public.notifications
        (id, recipient_profile_id, actor_profile_id, type, task_instance_id,
         activity_event_id, title, body, created_at)
      VALUES
        (v_notif_id, v_m, v_caller, 'mention',
         CASE WHEN p_entity_type = 'task.instance' THEN p_entity_id ELSE NULL END,
         v_event_id, v_notif_title, v_notif_body, now());
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'event_id', v_event_id,
    'mention_count', v_n_mentions
  );
END
$post_comment$;

REVOKE ALL ON FUNCTION public.post_activity_comment(text, text, text, text, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_activity_comment(text, text, text, text, uuid[]) TO authenticated;

-- ── 3. edit_activity_event — drop body-uuid validation ───────────────────
--
-- Same contract change. Author-only edit rules unchanged. New mentions
-- still trigger notifications; already-mentioned profiles are skipped to
-- avoid double-notifying on a body edit.

CREATE OR REPLACE FUNCTION public.edit_activity_event(
  p_event_id text,
  p_body     text,
  p_mentions uuid[] DEFAULT ARRAY[]::uuid[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $edit_event$
DECLARE
  v_caller uuid := auth.uid();
  v_row record;
  v_actor_name text;
  v_label text;
  v_m uuid;
  v_n_mentions int;
  v_mention_role text;
  v_already_mentioned boolean;
  v_notif_id text;
  v_notif_title text;
  v_notif_body text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'edit_activity_event: authenticated caller required';
  END IF;
  IF p_body IS NULL OR length(trim(p_body)) = 0 THEN
    RAISE EXCEPTION 'edit_activity_event: body required (non-empty)';
  END IF;
  IF length(p_body) > 4000 THEN
    RAISE EXCEPTION 'edit_activity_event: body too long';
  END IF;

  SELECT id, entity_type, entity_id, actor_profile_id, event_type, deleted_at,
         (payload->>'entity_label') AS entity_label
    INTO v_row
    FROM public.activity_events
    WHERE id = p_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'edit_activity_event: event % not found', p_event_id;
  END IF;
  IF v_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'edit_activity_event: event % is deleted', p_event_id;
  END IF;
  IF v_row.event_type <> 'comment.posted' THEN
    RAISE EXCEPTION 'edit_activity_event: only comment.posted events are editable';
  END IF;
  IF v_row.actor_profile_id IS DISTINCT FROM v_caller THEN
    RAISE EXCEPTION 'edit_activity_event: only the author may edit';
  END IF;

  v_n_mentions := COALESCE(array_length(p_mentions, 1), 0);
  IF v_n_mentions > 10 THEN
    RAISE EXCEPTION 'edit_activity_event: too many mentions';
  END IF;

  UPDATE public.activity_events
    SET body = p_body,
        edited_at = now(),
        payload = payload || jsonb_build_object('mention_count', v_n_mentions)
    WHERE id = p_event_id;

  -- Mention diff: keep existing rows (so dedup works), insert new ones.
  IF v_n_mentions > 0 THEN
    SELECT COALESCE(full_name, '') INTO v_actor_name
      FROM public.profiles WHERE id = v_caller;
    IF v_actor_name IS NULL OR length(trim(v_actor_name)) = 0 THEN
      v_actor_name := 'Someone';
    END IF;
    v_label := COALESCE(NULLIF(trim(COALESCE(v_row.entity_label, '')), ''), v_row.entity_id);

    FOREACH v_m IN ARRAY p_mentions LOOP
      SELECT role INTO v_mention_role FROM public.profiles WHERE id = v_m;
      IF v_mention_role IS NULL THEN
        RAISE EXCEPTION 'edit_activity_event: mentioned profile % not found', v_m;
      END IF;
      IF v_mention_role = 'inactive' THEN
        RAISE EXCEPTION 'edit_activity_event: mentioned profile % is inactive', v_m;
      END IF;

      SELECT EXISTS (
        SELECT 1 FROM public.activity_mentions
        WHERE event_id = p_event_id AND mentioned_profile_id = v_m
      ) INTO v_already_mentioned;

      INSERT INTO public.activity_mentions (event_id, mentioned_profile_id, created_at)
      VALUES (p_event_id, v_m, now())
      ON CONFLICT (event_id, mentioned_profile_id) DO NOTHING;

      IF v_already_mentioned OR v_m = v_caller THEN
        CONTINUE;
      END IF;

      v_notif_id := 'ntf-' || gen_random_uuid()::text;
      v_notif_title := v_actor_name || ' mentioned you on ' || v_label;
      v_notif_body := left(p_body, 200);
      INSERT INTO public.notifications
        (id, recipient_profile_id, actor_profile_id, type, task_instance_id,
         activity_event_id, title, body, created_at)
      VALUES
        (v_notif_id, v_m, v_caller, 'mention',
         CASE WHEN v_row.entity_type = 'task.instance' THEN v_row.entity_id ELSE NULL END,
         p_event_id, v_notif_title, v_notif_body, now());
    END LOOP;
  END IF;

  RETURN jsonb_build_object('ok', true, 'event_id', p_event_id);
END
$edit_event$;

REVOKE ALL ON FUNCTION public.edit_activity_event(text, text, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.edit_activity_event(text, text, uuid[]) TO authenticated;

-- Force PostgREST schema reload so the new list_activity_events return
-- shape (mentioned_profile_names column) is visible to the client right
-- away. Without this, callers see the OLD cached return shape and the
-- new column comes back undefined.
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- End of 060_activity_mention_contract.sql
-- ============================================================================
