-- 111_weigh_in_note_record_comments.sql
-- Mirror weigh-in notes into the current record-page comments stream.
--
-- Public weigh-in forms run with anon access, while record-page discussion
-- comments live behind SECURITY DEFINER RPCs and authenticated reads. These
-- triggers bridge that gap server-side so a note made during a weigh-in lands
-- on the visible animal or batch record without relying on hidden legacy
-- cattle_comments / sheep_comments timelines.
--
-- Entry notes:
--   cattle -> cattle.animal
--   sheep  -> sheep.animal
--   pig    -> pig.batch, resolved from the session batch label to the parent
--             feeder-group record id
--   broiler entry notes -> broiler.batch, for completeness
--
-- Session notes:
--   pig/broiler -> their batch records
--
-- Comment ids are deterministic:
--   wi-note-<weigh_ins.id>
--   wis-note-<weigh_in_sessions.id>
-- so edits update the same row and deletes remove it.

BEGIN;

CREATE OR REPLACE FUNCTION public._weigh_in_comment_author(p_team_member text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $fn$
DECLARE
  v_author uuid;
BEGIN
  IF p_team_member IS NULL OR btrim(p_team_member) = '' THEN
    RETURN NULL;
  END IF;

  SELECT p.id
    INTO v_author
    FROM public.profiles p
   WHERE lower(btrim(p.full_name)) = lower(btrim(p_team_member))
     AND COALESCE(p.role, '') <> 'inactive'
   ORDER BY p.full_name, p.id
   LIMIT 1;

  RETURN v_author;
END
$fn$;

REVOKE ALL ON FUNCTION public._weigh_in_comment_author(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._weigh_in_resolve_pig_batch(
  p_batch_label text,
  OUT entity_id text,
  OUT entity_label text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $fn$
DECLARE
  v_slug text;
  v_feeders jsonb;
  v_group jsonb;
  v_sub jsonb;
BEGIN
  entity_id := NULL;
  entity_label := NULL;

  IF p_batch_label IS NULL OR btrim(p_batch_label) = '' THEN
    RETURN;
  END IF;

  v_slug := public.pig_slug(p_batch_label);
  SELECT data INTO v_feeders FROM public.app_store WHERE key = 'ppp-feeders-v1';

  IF v_feeders IS NOT NULL AND jsonb_typeof(v_feeders) = 'array' THEN
    FOR v_group IN SELECT value FROM jsonb_array_elements(v_feeders) AS t(value)
    LOOP
      IF public.pig_slug(v_group->>'id') = v_slug
         OR public.pig_slug(v_group->>'batchName') = v_slug THEN
        entity_id := v_group->>'id';
        entity_label := COALESCE(NULLIF(v_group->>'batchName', ''), entity_id);
        RETURN;
      END IF;

      IF jsonb_typeof(COALESCE(v_group->'subBatches', '[]'::jsonb)) = 'array' THEN
        FOR v_sub IN SELECT value FROM jsonb_array_elements(COALESCE(v_group->'subBatches', '[]'::jsonb)) AS t(value)
        LOOP
          IF public.pig_slug(v_sub->>'id') = v_slug
             OR public.pig_slug(v_sub->>'name') = v_slug THEN
            entity_id := v_group->>'id';
            entity_label := COALESCE(NULLIF(v_group->>'batchName', ''), entity_id);
            RETURN;
          END IF;
        END LOOP;
      END IF;
    END LOOP;
  END IF;

  -- Fallback keeps older/simple data sets working where batch_id already is
  -- the pig.batch entity id.
  entity_id := p_batch_label;
  entity_label := p_batch_label;
END
$fn$;

REVOKE ALL ON FUNCTION public._weigh_in_resolve_pig_batch(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._upsert_weigh_in_comment(
  p_comment_id text,
  p_entity_type text,
  p_entity_id text,
  p_entity_label text,
  p_author_profile_id uuid,
  p_body text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_body text := left(COALESCE(p_body, ''), 4000);
BEGIN
  IF p_comment_id IS NULL OR btrim(p_comment_id) = ''
     OR p_entity_type IS NULL OR btrim(p_entity_type) = ''
     OR p_entity_id IS NULL OR btrim(p_entity_id) = ''
     OR btrim(v_body) = '' THEN
    RETURN;
  END IF;

  INSERT INTO public.comments (
    id,
    entity_type,
    entity_id,
    author_profile_id,
    body,
    mentions,
    attachments,
    created_at
  ) VALUES (
    p_comment_id,
    p_entity_type,
    p_entity_id,
    p_author_profile_id,
    v_body,
    ARRAY[]::uuid[],
    '[]'::jsonb,
    now()
  )
  ON CONFLICT (id) DO UPDATE
    SET entity_type = EXCLUDED.entity_type,
        entity_id = EXCLUDED.entity_id,
        author_profile_id = EXCLUDED.author_profile_id,
        body = EXCLUDED.body,
        mentions = ARRAY[]::uuid[],
        attachments = '[]'::jsonb,
        edited_at = CASE
          WHEN public.comments.body IS DISTINCT FROM EXCLUDED.body THEN now()
          ELSE public.comments.edited_at
        END,
        deleted_at = NULL,
        deleted_by = NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public._upsert_weigh_in_comment(text, text, text, text, uuid, text)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._delete_weigh_in_comment(p_comment_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF p_comment_id IS NULL OR btrim(p_comment_id) = '' THEN
    RETURN;
  END IF;

  DELETE FROM public.comments
   WHERE id = p_comment_id
     AND (id LIKE 'wi-note-%' OR id LIKE 'wis-note-%');
END
$fn$;

REVOKE ALL ON FUNCTION public._delete_weigh_in_comment(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.sync_weigh_in_entry_note_comment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_row public.weigh_ins%ROWTYPE;
  v_session public.weigh_in_sessions%ROWTYPE;
  v_comment_id text;
  v_note text;
  v_entity_type text;
  v_entity_id text;
  v_entity_label text;
  v_author uuid;
  v_body text;
  v_weight text;
  v_debug_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_debug_id := OLD.id;
    PERFORM public._delete_weigh_in_comment('wi-note-' || OLD.id);
    RETURN OLD;
  END IF;

  v_row := NEW;
  v_debug_id := v_row.id;
  v_comment_id := 'wi-note-' || v_row.id;
  v_note := NULLIF(btrim(COALESCE(v_row.note, '')), '');

  IF v_note IS NULL THEN
    PERFORM public._delete_weigh_in_comment(v_comment_id);
    RETURN NEW;
  END IF;

  SELECT *
    INTO v_session
    FROM public.weigh_in_sessions
   WHERE id = v_row.session_id;

  IF NOT FOUND THEN
    PERFORM public._delete_weigh_in_comment(v_comment_id);
    RETURN NEW;
  END IF;

  IF v_session.species = 'cattle' THEN
    v_entity_type := 'cattle.animal';

    SELECT c.id, COALESCE(NULLIF(c.tag, ''), c.id)
      INTO v_entity_id, v_entity_label
      FROM public.cattle c
     WHERE c.deleted_at IS NULL
       AND c.tag = v_row.tag
     ORDER BY c.id
     LIMIT 1;

    IF v_entity_id IS NULL THEN
      SELECT c.id, COALESCE(NULLIF(c.tag, ''), c.id)
        INTO v_entity_id, v_entity_label
        FROM public.cattle c
       WHERE c.deleted_at IS NULL
         AND EXISTS (
           SELECT 1
             FROM jsonb_array_elements(COALESCE(c.old_tags, '[]'::jsonb)) AS ot
            WHERE ot->>'tag' = v_row.tag
              AND COALESCE(ot->>'source', '') <> 'import'
         )
       ORDER BY c.id
       LIMIT 1;
    END IF;
  ELSIF v_session.species = 'sheep' THEN
    v_entity_type := 'sheep.animal';

    SELECT s.id, COALESCE(NULLIF(s.tag, ''), s.id)
      INTO v_entity_id, v_entity_label
      FROM public.sheep s
     WHERE s.deleted_at IS NULL
       AND s.tag = v_row.tag
     ORDER BY s.id
     LIMIT 1;

    IF v_entity_id IS NULL THEN
      SELECT s.id, COALESCE(NULLIF(s.tag, ''), s.id)
        INTO v_entity_id, v_entity_label
        FROM public.sheep s
       WHERE s.deleted_at IS NULL
         AND EXISTS (
           SELECT 1
             FROM jsonb_array_elements(COALESCE(s.old_tags, '[]'::jsonb)) AS ot
            WHERE ot->>'tag' = v_row.tag
              AND COALESCE(ot->>'source', '') <> 'import'
         )
       ORDER BY s.id
       LIMIT 1;
    END IF;
  ELSIF v_session.species = 'pig' THEN
    v_entity_type := 'pig.batch';
    SELECT r.entity_id, r.entity_label
      INTO v_entity_id, v_entity_label
      FROM public._weigh_in_resolve_pig_batch(v_session.batch_id) AS r;
  ELSIF v_session.species = 'broiler' THEN
    v_entity_type := 'broiler.batch';
    v_entity_id := v_session.batch_id;
    v_entity_label := v_session.batch_id;
  END IF;

  IF v_entity_type IS NULL OR v_entity_id IS NULL OR btrim(v_entity_id) = '' THEN
    PERFORM public._delete_weigh_in_comment(v_comment_id);
    RETURN NEW;
  END IF;

  v_author := public._weigh_in_comment_author(v_session.team_member);
  v_weight := trim(to_char(v_row.weight, 'FM999999990.##'));
  v_body := 'Weigh-in note (' || v_session.date::text;
  IF v_row.weight IS NOT NULL THEN
    v_body := v_body || ', ' || v_weight || ' lb';
  END IF;
  v_body := v_body || '): ' || v_note;

  PERFORM public._upsert_weigh_in_comment(
    v_comment_id,
    v_entity_type,
    v_entity_id,
    COALESCE(NULLIF(v_entity_label, ''), v_entity_id),
    v_author,
    v_body
  );

  RETURN NEW;
EXCEPTION WHEN others THEN
  RAISE WARNING 'sync_weigh_in_entry_note_comment failed for %: %',
    COALESCE(v_debug_id, 'unknown'), SQLERRM;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.sync_weigh_in_entry_note_comment() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS weigh_in_entry_note_comment_sync ON public.weigh_ins;
CREATE TRIGGER weigh_in_entry_note_comment_sync
AFTER INSERT OR UPDATE OF note, tag, session_id, weight, new_tag_flag OR DELETE
ON public.weigh_ins
FOR EACH ROW
EXECUTE FUNCTION public.sync_weigh_in_entry_note_comment();

CREATE OR REPLACE FUNCTION public.sync_weigh_in_session_note_comment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_row public.weigh_in_sessions%ROWTYPE;
  v_comment_id text;
  v_note text;
  v_entity_type text;
  v_entity_id text;
  v_entity_label text;
  v_author uuid;
  v_body text;
  v_debug_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_debug_id := OLD.id;
    PERFORM public._delete_weigh_in_comment('wis-note-' || OLD.id);
    RETURN OLD;
  END IF;

  v_row := NEW;
  v_debug_id := v_row.id;
  v_comment_id := 'wis-note-' || v_row.id;
  v_note := NULLIF(btrim(COALESCE(v_row.notes, '')), '');

  IF v_note IS NULL THEN
    PERFORM public._delete_weigh_in_comment(v_comment_id);
    RETURN NEW;
  END IF;

  IF v_row.species = 'pig' THEN
    v_entity_type := 'pig.batch';
    SELECT r.entity_id, r.entity_label
      INTO v_entity_id, v_entity_label
      FROM public._weigh_in_resolve_pig_batch(v_row.batch_id) AS r;
  ELSIF v_row.species = 'broiler' THEN
    v_entity_type := 'broiler.batch';
    v_entity_id := v_row.batch_id;
    v_entity_label := v_row.batch_id;
  ELSE
    PERFORM public._delete_weigh_in_comment(v_comment_id);
    RETURN NEW;
  END IF;

  IF v_entity_type IS NULL OR v_entity_id IS NULL OR btrim(v_entity_id) = '' THEN
    PERFORM public._delete_weigh_in_comment(v_comment_id);
    RETURN NEW;
  END IF;

  v_author := public._weigh_in_comment_author(v_row.team_member);
  v_body := 'Weigh-in session note (' || v_row.date::text || '): ' || v_note;

  PERFORM public._upsert_weigh_in_comment(
    v_comment_id,
    v_entity_type,
    v_entity_id,
    COALESCE(NULLIF(v_entity_label, ''), v_entity_id),
    v_author,
    v_body
  );

  RETURN NEW;
EXCEPTION WHEN others THEN
  RAISE WARNING 'sync_weigh_in_session_note_comment failed for %: %',
    COALESCE(v_debug_id, 'unknown'), SQLERRM;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.sync_weigh_in_session_note_comment() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS weigh_in_session_note_comment_sync_upsert ON public.weigh_in_sessions;
CREATE TRIGGER weigh_in_session_note_comment_sync_upsert
AFTER INSERT OR UPDATE OF notes, batch_id, species, team_member, date
ON public.weigh_in_sessions
FOR EACH ROW
EXECUTE FUNCTION public.sync_weigh_in_session_note_comment();

DROP TRIGGER IF EXISTS weigh_in_session_note_comment_sync_delete ON public.weigh_in_sessions;
CREATE TRIGGER weigh_in_session_note_comment_sync_delete
AFTER DELETE
ON public.weigh_in_sessions
FOR EACH ROW
EXECUTE FUNCTION public.sync_weigh_in_session_note_comment();

COMMIT;
