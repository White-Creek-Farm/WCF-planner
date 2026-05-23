-- ============================================================================
-- 058_activity_events.sql
-- ----------------------------------------------------------------------------
-- Activity + @Mentions platform foundation (Phase 1).
--
-- Phase 1 scope (per cc-research/activity-mentions-plan/):
--   * activity_events + activity_mentions tables with locked-down RLS
--   * profile_role() + profile_program_access() companions to is_admin()
--   * permission resolver (_activity_can_read / _activity_can_write) that
--     handles task.* entity types and FAILS CLOSED for unknown types
--   * 4 SECURITY DEFINER RPCs: list / post / edit / delete
--   * AFTER UPDATE trigger on task_instances → emits 'task.completed' events
--   * notifications widen: type CHECK adds 'mention'; new
--     activity_event_id column FK→activity_events
--
-- Out of scope for Phase 1 (planned for later migrations):
--   * Equipment / cattle / sheep / etc. resolver branches
--   * Existing cattle_comments / sheep_comments absorption
--   * Backfill of historical comment rows
--   * Per-user mention mute setting
--
-- Hard rules locked here:
--   * No SELECT/INSERT/UPDATE/DELETE policy on activity_events or
--     activity_mentions. SECDEF RPCs are the ONLY client-reachable path.
--     REVOKE ALL from authenticated/anon.
--   * Mention notifications fan out server-side ONLY (inside
--     post_activity_comment / edit_activity_event). Clients never call
--     .from('notifications').insert on this path.
--   * Soft-delete only via delete_activity_event. No DELETE policy.
--   * Mentions cap: 10 per comment (RPC enforced). Self-mention skips
--     notification but still records the mention row.
-- ============================================================================

-- ── 1. profile helpers ────────────────────────────────────────────────────
--
-- Authenticated-only grants. Unlike public.is_admin() (mig 037) which
-- deliberately stays anon-tolerant to avoid the PostgREST/Auth login
-- failure described in that migration, these helpers are NOT called by
-- the login path; they are called exclusively by activity SECDEF RPCs
-- which themselves are authenticated-only. REVOKE-from-PUBLIC + GRANT-
-- to-authenticated keeps the surface tight without the login-break
-- risk. Anon callers receive permission-denied; activity tables are
-- already locked down separately and never reach these helpers anyway.

CREATE OR REPLACE FUNCTION public.profile_role()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $profile_role$
  SELECT role FROM public.profiles WHERE id = auth.uid()
$profile_role$;

REVOKE ALL ON FUNCTION public.profile_role() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.profile_role() TO authenticated;

CREATE OR REPLACE FUNCTION public.profile_program_access()
RETURNS text[]
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $profile_program_access$
  SELECT program_access FROM public.profiles WHERE id = auth.uid()
$profile_program_access$;

REVOKE ALL ON FUNCTION public.profile_program_access() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.profile_program_access() TO authenticated;

-- ── 2. activity_events table ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.activity_events (
  id                text PRIMARY KEY,
  entity_type       text NOT NULL,
  entity_id         text NOT NULL,
  actor_profile_id  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  event_type        text NOT NULL,
  body              text,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  edited_at         timestamptz,
  deleted_at        timestamptz,
  CONSTRAINT activity_events_entity_check
    CHECK (length(entity_type) > 0 AND length(entity_id) > 0),
  CONSTRAINT activity_events_event_type_check
    CHECK (event_type ~ '^[a-z][a-z0-9._]+$')
);

-- Canonical "list by entity, newest first" index. Skips soft-deleted.
CREATE INDEX IF NOT EXISTS activity_events_entity_idx
  ON public.activity_events (entity_type, entity_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- Author-scoped lookup for future "show my recent comments" features.
CREATE INDEX IF NOT EXISTS activity_events_actor_idx
  ON public.activity_events (actor_profile_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- ── 3. activity_mentions table ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.activity_mentions (
  event_id              text NOT NULL REFERENCES public.activity_events(id) ON DELETE CASCADE,
  mentioned_profile_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, mentioned_profile_id)
);

CREATE INDEX IF NOT EXISTS activity_mentions_profile_idx
  ON public.activity_mentions (mentioned_profile_id, created_at DESC);

-- ── 4. RLS lockdown ──────────────────────────────────────────────────────
--
-- Both tables get RLS enabled with NO policies. SECURITY DEFINER RPCs are
-- the only writers/readers from the client side; service_role bypasses
-- RLS by definition. REVOKE ALL from authenticated/anon ensures a
-- PostgREST call that bypasses the RPC layer cannot reach the rows.

ALTER TABLE public.activity_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_mentions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.activity_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.activity_mentions FROM PUBLIC, anon, authenticated;

-- ── 5. Permission resolver ────────────────────────────────────────────────
--
-- Phase 1 supports task.* entity types only. Everything else FAILS CLOSED.
-- Phase 2 onward extends the CASE expression in place (no schema change).
--
-- _activity_can_read returns true if the caller can SEE activity for the
-- entity. _activity_can_write returns true if the caller can POST a
-- comment on the entity (same rules in Phase 1 EXCEPT inactive role is
-- locked out from writes even if reads happen to allow them).

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
  v_role text;
BEGIN
  IF p_entity_type IS NULL OR length(trim(p_entity_type)) = 0 THEN
    RETURN false;
  END IF;
  IF p_entity_id IS NULL OR length(trim(p_entity_id)) = 0 THEN
    RETURN false;
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL THEN
    -- Unauthed (anon) or no profile row.
    RETURN false;
  END IF;
  IF v_role = 'inactive' THEN
    RETURN false;
  END IF;

  -- Phase 1 — task.* entity types. Tasks v2 transparency RLS lets every
  -- authed user SELECT every task_instances / task_templates /
  -- task_system_rules row, so the role gate (authed + not inactive,
  -- handled above) is sufficient for read. BUT we ALWAYS verify the
  -- source row exists — fake / typo / deleted ids must NOT accept
  -- comments OR return readable timelines, even for admins. The
  -- existence probe runs BEFORE the admin short-circuit so admins
  -- cannot bypass entity-validity checks. The admin short-circuit
  -- (further below) only applies AFTER existence is proven.
  IF p_entity_type = 'task.instance' THEN
    IF NOT EXISTS (SELECT 1 FROM public.task_instances WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    RETURN true;
  ELSIF p_entity_type = 'task.template' THEN
    IF NOT EXISTS (SELECT 1 FROM public.task_templates WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    RETURN true;
  ELSIF p_entity_type = 'task.system_rule' THEN
    IF NOT EXISTS (SELECT 1 FROM public.task_system_rules WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    RETURN true;
  END IF;

  -- Unknown entity_type. Fail closed even for admins — adding a new
  -- entity_type requires extending the CASE above so existence checks
  -- stay enforced. Admin bypass is intentionally not a fallback here.
  RETURN false;
END
$can_read$;

REVOKE ALL ON FUNCTION public._activity_can_read(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._activity_can_read(text, text) TO authenticated;

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
  -- Same read gate; if you can see it, you can comment on it (Phase 1).
  RETURN public._activity_can_read(p_entity_type, p_entity_id);
END
$can_write$;

REVOKE ALL ON FUNCTION public._activity_can_write(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._activity_can_write(text, text) TO authenticated;

-- ── 6. Mention helpers ───────────────────────────────────────────────────
--
-- Mentions are encoded inline in the comment body as:
--     @[Display Name](profile:<uuid>)
-- This is a reversible format the renderer can split into
-- {display, profile_id}. _extract_mention_uuids returns the deduplicated
-- list of uuids actually present in the body so the RPC can sanity-check
-- the client-supplied p_mentions array against the text.

CREATE OR REPLACE FUNCTION public._extract_mention_uuids(p_body text)
RETURNS uuid[]
LANGUAGE plpgsql
IMMUTABLE
AS $extract$
DECLARE
  v_match text;
  v_result uuid[] := ARRAY[]::uuid[];
  v_seen boolean;
  v_existing uuid;
BEGIN
  IF p_body IS NULL OR length(p_body) = 0 THEN
    RETURN v_result;
  END IF;
  FOR v_match IN
    SELECT (regexp_matches(p_body, '\(profile:([0-9a-fA-F-]{36})\)', 'g'))[1]
  LOOP
    v_seen := false;
    FOREACH v_existing IN ARRAY v_result LOOP
      IF v_existing = v_match::uuid THEN
        v_seen := true;
        EXIT;
      END IF;
    END LOOP;
    IF NOT v_seen THEN
      v_result := array_append(v_result, v_match::uuid);
    END IF;
  END LOOP;
  RETURN v_result;
END
$extract$;

REVOKE ALL ON FUNCTION public._extract_mention_uuids(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._extract_mention_uuids(text) TO authenticated;

-- ── 7. Notifications: widen type CHECK + add activity_event_id ───────────

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check CHECK (type IN ('task_completed', 'mention'));

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS activity_event_id text REFERENCES public.activity_events(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS notifications_activity_event_idx
  ON public.notifications (activity_event_id)
  WHERE activity_event_id IS NOT NULL;

-- ── 8. list_activity_events ───────────────────────────────────────────────
--
-- Drop-then-CREATE (not CREATE OR REPLACE) because the RETURNS TABLE
-- shape gained actor_display_name in this revision; Postgres refuses to
-- change return shape via CREATE OR REPLACE. Drop is idempotent via
-- IF EXISTS and the function has no dependents (the SECDEF RPCs are
-- the only callers, and they read the result rows directly).

DROP FUNCTION IF EXISTS public.list_activity_events(text, text, int);

CREATE FUNCTION public.list_activity_events(
  p_entity_type text,
  p_entity_id   text,
  p_limit       int DEFAULT 50
) RETURNS TABLE (
  id                    text,
  entity_type           text,
  entity_id             text,
  actor_profile_id      uuid,
  actor_display_name    text,
  event_type            text,
  body                  text,
  payload               jsonb,
  created_at            timestamptz,
  edited_at             timestamptz,
  deleted_at            timestamptz,
  mentioned_profile_ids uuid[]
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
      -- Resolve the actor's display name server-side so the panel
      -- doesn't have to round-trip to profiles per-event. NULL when
      -- the row is a system/trigger event (no actor profile) or when
      -- the actor profile has been deleted (FK→profiles is ON DELETE
      -- SET NULL); the client renders a safe fallback.
      --
      -- profiles.id MUST be table-qualified — bare `id` here collides
      -- with the function's RETURNS TABLE column named `id`, raising
      -- "column reference id is ambiguous" at runtime (silent in
      -- PostgREST → empty data, no error to the client).
      (SELECT p.full_name FROM public.profiles p WHERE p.id = ae.actor_profile_id) AS actor_display_name,
      ae.event_type, ae.body, ae.payload,
      ae.created_at, ae.edited_at, ae.deleted_at,
      COALESCE(
        (SELECT array_agg(am.mentioned_profile_id)
           FROM public.activity_mentions am
          WHERE am.event_id = ae.id),
        ARRAY[]::uuid[]
      )
    FROM public.activity_events ae
    WHERE ae.entity_type = p_entity_type
      AND ae.entity_id = p_entity_id
    ORDER BY ae.created_at DESC
    LIMIT v_limit;
END
$list_activity$;

REVOKE ALL ON FUNCTION public.list_activity_events(text, text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_activity_events(text, text, int) TO authenticated;

-- ── 9. count_activity_for_entity ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.count_activity_for_entity(
  p_entity_type text,
  p_entity_id   text
) RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $count_activity$
DECLARE
  v_n int;
BEGIN
  IF NOT public._activity_can_read(p_entity_type, p_entity_id) THEN
    RAISE EXCEPTION 'count_activity_for_entity: not permitted for entity_type=%', p_entity_type;
  END IF;
  SELECT count(*) INTO v_n
    FROM public.activity_events
    WHERE entity_type = p_entity_type
      AND entity_id   = p_entity_id
      AND deleted_at IS NULL;
  RETURN COALESCE(v_n, 0);
END
$count_activity$;

REVOKE ALL ON FUNCTION public.count_activity_for_entity(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.count_activity_for_entity(text, text) TO authenticated;

-- ── 10. post_activity_comment ─────────────────────────────────────────────
--
-- Creates a 'comment.posted' activity_event, validates mentions against
-- the body's inline markup, inserts activity_mentions rows, and fans out
-- 'mention' notifications (server-side; client never inserts into
-- notifications on this path).
--
-- Mention rules:
--   * Cap: 10 mentions per comment.
--   * p_mentions[] must be a subset of the uuids extracted from the body
--     by _extract_mention_uuids — clients cannot fan out to arbitrary
--     profiles.
--   * Inactive profiles are rejected (RAISE).
--   * Self-mentions: the mention row IS recorded (so the renderer can
--     highlight the @name) but NO notification fires.

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
  v_extracted uuid[];
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

  -- Validate every uuid in p_mentions actually appears in the body.
  -- Reject otherwise — clients cannot notify arbitrary profiles.
  IF v_n_mentions > 0 THEN
    v_extracted := public._extract_mention_uuids(p_body);
    FOREACH v_m IN ARRAY p_mentions LOOP
      IF NOT (v_m = ANY(v_extracted)) THEN
        RAISE EXCEPTION 'post_activity_comment: mention % not present in body', v_m;
      END IF;
    END LOOP;
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

-- ── 11. edit_activity_event ───────────────────────────────────────────────
--
-- Author-only. Only the body + mentions can change. Editing a comment
-- replaces the mention rows: new mentions get notifications (unless
-- they were already mentioned in the prior version — dedup). Removed
-- mentions do not affect existing notifications (those were already
-- delivered).

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
  v_extracted uuid[];
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
  IF v_n_mentions > 0 THEN
    v_extracted := public._extract_mention_uuids(p_body);
    FOREACH v_m IN ARRAY p_mentions LOOP
      IF NOT (v_m = ANY(v_extracted)) THEN
        RAISE EXCEPTION 'edit_activity_event: mention % not present in body', v_m;
      END IF;
    END LOOP;
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

      -- Already mentioned? Skip the notification (the original send
      -- already delivered). Use a probe SELECT before INSERT for clarity.
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

-- ── 12. delete_activity_event ─────────────────────────────────────────────
--
-- Soft-delete only. Author OR admin. Sets deleted_at = now(); the row
-- stays so the timeline renders "(comment deleted)" in place. Idempotent
-- on already-deleted rows (returns ok).

CREATE OR REPLACE FUNCTION public.delete_activity_event(p_event_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $delete_event$
DECLARE
  v_caller uuid := auth.uid();
  v_admin boolean := public.is_admin();
  v_row record;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'delete_activity_event: authenticated caller required';
  END IF;
  SELECT id, actor_profile_id, deleted_at, event_type
    INTO v_row
    FROM public.activity_events
    WHERE id = p_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'delete_activity_event: event % not found', p_event_id;
  END IF;
  IF v_row.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'idempotent_replay', true, 'event_id', p_event_id);
  END IF;
  IF v_row.event_type <> 'comment.posted' THEN
    RAISE EXCEPTION 'delete_activity_event: only comment.posted events are deletable';
  END IF;
  IF NOT v_admin AND v_row.actor_profile_id IS DISTINCT FROM v_caller THEN
    RAISE EXCEPTION 'delete_activity_event: only author or admin may delete';
  END IF;
  UPDATE public.activity_events
    SET deleted_at = now(),
        body = NULL,
        payload = payload || jsonb_build_object('deleted_by', v_caller::text)
    WHERE id = p_event_id;
  RETURN jsonb_build_object('ok', true, 'idempotent_replay', false, 'event_id', p_event_id);
END
$delete_event$;

REVOKE ALL ON FUNCTION public.delete_activity_event(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_activity_event(text) TO authenticated;

-- ── 13. task.completed trigger ────────────────────────────────────────────
--
-- AFTER UPDATE on task_instances when status flips to 'completed'. Emits
-- one 'task.completed' activity event with body = completion_note. Runs
-- regardless of whether the completion came from the v1 or v2 RPC, so
-- legacy paths populate the activity timeline too.

CREATE OR REPLACE FUNCTION public._activity_emit_task_completed()
RETURNS trigger
LANGUAGE plpgsql
AS $emit_task_completed$
DECLARE
  v_event_id text;
  v_photo_count int;
BEGIN
  IF NEW.status = 'completed'
     AND (OLD.status IS DISTINCT FROM 'completed') THEN
    SELECT count(*) INTO v_photo_count
      FROM public.task_instance_photos
      WHERE instance_id = NEW.id AND kind = 'completion';
    v_event_id := 'ae-' || gen_random_uuid()::text;
    INSERT INTO public.activity_events
      (id, entity_type, entity_id, actor_profile_id, event_type, body, payload, created_at)
    VALUES
      (v_event_id, 'task.instance', NEW.id, NEW.completed_by_profile_id,
       'task.completed',
       NEW.completion_note,
       jsonb_build_object(
         'photo_count', v_photo_count,
         'completed_by', NEW.completed_by_profile_id,
         'entity_label', NEW.title
       ),
       COALESCE(NEW.completed_at, now()));
  END IF;
  RETURN NEW;
END
$emit_task_completed$;

DROP TRIGGER IF EXISTS task_instances_emit_completed ON public.task_instances;
CREATE TRIGGER task_instances_emit_completed
  AFTER UPDATE ON public.task_instances
  FOR EACH ROW
  EXECUTE FUNCTION public._activity_emit_task_completed();

-- ============================================================================
-- End of 058_activity_events.sql
-- ============================================================================
