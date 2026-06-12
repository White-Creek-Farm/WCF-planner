-- ============================================================================
-- 112_cattle_log.sql
-- ----------------------------------------------------------------------------
-- Cattle Log: a singleton comment stream (entity_type 'cattle.log', entity_id
-- 'cattle-log') where field users jot observations about cows by #tag. Each
-- '#<digits>' reference that resolves to exactly one ACTIVE cow (deleted_at IS
-- NULL, herd IN mommas/backgrounders/finishers/bulls; current tag first, then
-- non-import old_tags per mig 110) gets a MIRROR comment on that cow's page
-- (entity_type 'cattle.animal'). Unmatched tags create unresolved link rows
-- (work queue for new calves) and force the entry into the Issues filter.
--
-- 1. cattle_log_issue_state + cattle_log_tag_links tables (deny-all RLS,
--    REVOKE ALL; SECDEF-only access, like comments in mig 071).
-- 2. SECDEF RPC family: submit/edit/delete_cattle_log_entry,
--    set_cattle_log_issue, list_cattle_log_entries,
--    list_cattle_log_mentionable_profiles. Roles: light/farm_team/management/
--    admin view+add; authors edit own; management/admin delete + toggle issue.
-- 3. Resolver trigger on cattle (INSERT OR UPDATE OF tag, old_tags): when an
--    unresolved tag later matches unambiguously, create the mirror and link.
--    Never touches is_issue. Exception-guarded so cattle writes never fail.
-- 4. Mirror + originals guards: edit_comment/delete_comment (mig 071, latest
--    definitions) re-issued with an early clause blocking 'clog-' mirror ids
--    AND a post-fetch clause blocking entity_type 'cattle.log' originals —
--    both are managed exclusively by the Cattle Log RPC family.
-- 5. _activity_can_read (latest: mig 078) re-issued with a 'cattle.log'
--    branch — explicit role gate (light/farm_team/management/admin), NOT
--    profile_program_access; equipment_tech and inactive have no access.
--    _activity_can_write (latest: mig 062) re-issued with a 'cattle.log'
--    branch that returns FALSE: generic comment writes can never bypass the
--    Cattle Log RPCs.
--
-- Error classes (client classifyCattleLogError): CATTLE_LOG_AMBIGUOUS_TAG,
-- CATTLE_LOG_MENTION_INVALID, CATTLE_LOG_VALIDATION; anything else transient.
-- The bare 'authenticated caller required' message is deliberately UNprefixed
-- so an expired offline session classifies transient and stays queued.
--
-- Replay idempotency: submit_cattle_log_entry(p_id ...) returns the existing
-- summary with replayed:true when the entry already exists (offline replay).
--
-- Mirror ids: 'clog-' || <entryId> || '--' || <cattleId> (deterministic;
-- entry ids and cattle ids never contain '--'). Entry ids are client-minted
-- 'cl-...' and must never start with 'clog-'.
--
-- NO BEGIN/COMMIT in this file: TEST applies via exec_sql (rejects them);
-- PROD applies with psql --single-transaction for atomicity.
-- Apply order: TEST first, PROD after lane approval.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── 1. cattle_log_issue_state table ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.cattle_log_issue_state (
  comment_id  text PRIMARY KEY REFERENCES public.comments(id) ON DELETE CASCADE,
  is_issue    boolean NOT NULL DEFAULT true,
  last_set_by uuid REFERENCES public.profiles(id),
  last_set_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON TABLE public.cattle_log_issue_state FROM PUBLIC, anon, authenticated;

ALTER TABLE public.cattle_log_issue_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cattle_log_issue_state_deny_all ON public.cattle_log_issue_state;
CREATE POLICY cattle_log_issue_state_deny_all ON public.cattle_log_issue_state
  FOR ALL USING (false);

-- ── 2. cattle_log_tag_links table ───────────────────────────────────────────
-- cattle_id NULL means unresolved. The unresolved system note on the log page
-- is DERIVED from these rows (no extra storage). calf_* fields hold the
-- new-calf details collected for unmatched tags (online flow requires them;
-- offline replay may omit them).

CREATE TABLE IF NOT EXISTS public.cattle_log_tag_links (
  id                 text PRIMARY KEY,
  comment_id         text NOT NULL REFERENCES public.comments(id) ON DELETE CASCADE,
  tag                text NOT NULL,
  cattle_id          text REFERENCES public.cattle(id),
  mirror_comment_id  text,
  calf_herd          text,
  calf_dob           date,
  calf_dob_estimated boolean,
  calf_sex           text,
  calf_origin        text,
  calf_dam_tag       text,
  calf_breed         text,
  calf_note          text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (comment_id, tag)
);

-- Resolver lookup: unresolved links by tag.
CREATE INDEX IF NOT EXISTS cattle_log_tag_links_unresolved_tag_idx
  ON public.cattle_log_tag_links (tag) WHERE cattle_id IS NULL;

CREATE INDEX IF NOT EXISTS cattle_log_tag_links_comment_idx
  ON public.cattle_log_tag_links (comment_id);

-- Mirror-guard lookup in edit_comment/delete_comment (runs on every generic
-- comment edit/delete, so keep it indexed).
CREATE INDEX IF NOT EXISTS cattle_log_tag_links_mirror_idx
  ON public.cattle_log_tag_links (mirror_comment_id) WHERE mirror_comment_id IS NOT NULL;

REVOKE ALL ON TABLE public.cattle_log_tag_links FROM PUBLIC, anon, authenticated;

ALTER TABLE public.cattle_log_tag_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cattle_log_tag_links_deny_all ON public.cattle_log_tag_links;
CREATE POLICY cattle_log_tag_links_deny_all ON public.cattle_log_tag_links
  FOR ALL USING (false);

-- ── 3. Internal helpers (SECDEF-internal; no client EXECUTE) ────────────────

-- Parse '#<digits>' tag references out of a body. Exact text match ('#0123'
-- differs from '#123'), deduped, first-occurrence order preserved.
CREATE OR REPLACE FUNCTION public._cattle_log_parse_tags(p_body text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $cl_parse$
  SELECT COALESCE(array_agg(t.tag ORDER BY t.first_ord), ARRAY[]::text[])
  FROM (
    SELECT r.m[1] AS tag, min(r.ord) AS first_ord
    FROM regexp_matches(COALESCE(p_body, ''), '#([0-9]+)', 'g') WITH ORDINALITY AS r(m, ord)
    GROUP BY r.m[1]
  ) t
$cl_parse$;

REVOKE ALL ON FUNCTION public._cattle_log_parse_tags(text) FROM PUBLIC, anon, authenticated;

-- Authoritative tag -> cattle match (mig 110 rule): ACTIVE cattle only
-- (deleted_at IS NULL, herd in the four active herds). Current tag match wins;
-- only when there is NO current-tag match fall back to old_tags entries whose
-- source is not 'import'. Returns the distinct matching cattle ids; more than
-- one element means AMBIGUOUS.
CREATE OR REPLACE FUNCTION public._cattle_log_match_tag(p_tag text)
RETURNS text[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $cl_match$
DECLARE
  v_ids text[];
BEGIN
  IF p_tag IS NULL OR length(p_tag) = 0 THEN
    RETURN ARRAY[]::text[];
  END IF;

  SELECT COALESCE(array_agg(DISTINCT c.id), ARRAY[]::text[])
    INTO v_ids
    FROM public.cattle c
   WHERE c.deleted_at IS NULL
     AND c.herd IN ('mommas', 'backgrounders', 'finishers', 'bulls')
     AND c.tag = p_tag;

  IF COALESCE(array_length(v_ids, 1), 0) > 0 THEN
    RETURN v_ids;
  END IF;

  SELECT COALESCE(array_agg(DISTINCT c.id), ARRAY[]::text[])
    INTO v_ids
    FROM public.cattle c
   WHERE c.deleted_at IS NULL
     AND c.herd IN ('mommas', 'backgrounders', 'finishers', 'bulls')
     AND EXISTS (
       SELECT 1
         FROM jsonb_array_elements(COALESCE(c.old_tags, '[]'::jsonb)) AS ot
        WHERE ot->>'tag' = p_tag
          AND COALESCE(ot->>'source', '') <> 'import'
     );

  RETURN v_ids;
END
$cl_match$;

REVOKE ALL ON FUNCTION public._cattle_log_match_tag(text) FROM PUBLIC, anon, authenticated;

-- Deterministic mirror upsert. Mirrors are real comments rows on the cow page
-- (entity_type 'cattle.animal') carrying the SAME body/author/attachments as
-- the original log entry. Mentions stay empty on mirrors (notifications fan
-- out from the log RPCs only). ON CONFLICT (id) DO UPDATE for replay/resync
-- safety, copying the mig 111 mirror-comment pattern. The mirror's created_at
-- is copied from the ORIGINAL entry's created_at ('mirrors show same time'):
-- mirrors created LATE (resolver, or an edit adding a tag) must not carry
-- now(). The ON CONFLICT update never touches created_at.
CREATE OR REPLACE FUNCTION public._cattle_log_upsert_mirror(
  p_entry_id    text,
  p_cattle_id   text,
  p_author      uuid,
  p_body        text,
  p_attachments jsonb
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $cl_mirror$
DECLARE
  v_mirror_id  text := 'clog-' || p_entry_id || '--' || p_cattle_id;
  v_created_at timestamptz;
BEGIN
  -- Every caller upserts mirrors only after the original entry row exists;
  -- the now() fallback is defensive only.
  SELECT created_at INTO v_created_at FROM public.comments WHERE id = p_entry_id;
  INSERT INTO public.comments
    (id, entity_type, entity_id, author_profile_id, body, mentions, attachments, created_at)
  VALUES
    (v_mirror_id, 'cattle.animal', p_cattle_id, p_author, p_body,
     ARRAY[]::uuid[], COALESCE(p_attachments, '[]'::jsonb), COALESCE(v_created_at, now()))
  ON CONFLICT (id) DO UPDATE
    SET entity_type = EXCLUDED.entity_type,
        entity_id = EXCLUDED.entity_id,
        author_profile_id = EXCLUDED.author_profile_id,
        body = EXCLUDED.body,
        mentions = ARRAY[]::uuid[],
        attachments = EXCLUDED.attachments,
        edited_at = CASE
          WHEN public.comments.body IS DISTINCT FROM EXCLUDED.body
            OR public.comments.attachments IS DISTINCT FROM EXCLUDED.attachments
          THEN now()
          ELSE public.comments.edited_at
        END,
        deleted_at = NULL,
        deleted_by = NULL;
  RETURN v_mirror_id;
END
$cl_mirror$;

REVOKE ALL ON FUNCTION public._cattle_log_upsert_mirror(text, text, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;

-- Shared body/mention/attachment validation for submit + edit. Mention
-- failures use the CATTLE_LOG_MENTION_INVALID prefix; everything else uses
-- CATTLE_LOG_VALIDATION. Mirrors the mig 071 post_comment checks, with the
-- Cattle Log role set and the fixed 'cattle.log/cattle-log/' path scope.
CREATE OR REPLACE FUNCTION public._cattle_log_validate_payload(
  p_caller      uuid,
  p_body        text,
  p_mentions    uuid[],
  p_attachments jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $cl_payload$
DECLARE
  v_n_mentions   int;
  v_m            uuid;
  v_mention_role text;
  v_n_attach     int;
  i              int;
BEGIN
  IF p_body IS NULL OR length(btrim(p_body)) < 4 THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: body must be at least 4 characters';
  END IF;
  IF length(p_body) > 4000 THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: body too long (% chars; max 4000)', length(p_body);
  END IF;

  v_n_mentions := COALESCE(array_length(p_mentions, 1), 0);
  IF v_n_mentions > 10 THEN
    RAISE EXCEPTION 'CATTLE_LOG_MENTION_INVALID: too many mentions (% > 10)', v_n_mentions;
  END IF;
  IF v_n_mentions > 0 THEN
    FOREACH v_m IN ARRAY p_mentions LOOP
      IF v_m = p_caller THEN
        RAISE EXCEPTION 'CATTLE_LOG_MENTION_INVALID: cannot mention yourself';
      END IF;
      SELECT role INTO v_mention_role FROM public.profiles WHERE id = v_m;
      IF v_mention_role IS NULL THEN
        RAISE EXCEPTION 'CATTLE_LOG_MENTION_INVALID: mentioned profile % not found', v_m;
      END IF;
      IF v_mention_role NOT IN ('light', 'farm_team', 'management', 'admin') THEN
        RAISE EXCEPTION 'CATTLE_LOG_MENTION_INVALID: mentioned profile % is not mentionable', v_m;
      END IF;
    END LOOP;
  END IF;

  IF p_attachments IS NULL OR jsonb_typeof(p_attachments) <> 'array' THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: attachments must be a JSON array';
  END IF;
  v_n_attach := jsonb_array_length(p_attachments);
  IF v_n_attach > 5 THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: too many attachments (% > 5)', v_n_attach;
  END IF;
  FOR i IN 0 .. v_n_attach - 1 LOOP
    IF (p_attachments->i->>'path') IS NULL OR length(p_attachments->i->>'path') = 0 THEN
      RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: attachment[%] missing path', i;
    END IF;
    IF NOT starts_with(p_attachments->i->>'path', 'cattle.log/cattle-log/') THEN
      RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: attachment[%] path not scoped to the cattle log', i;
    END IF;
    IF (p_attachments->i->>'name') IS NULL THEN
      RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: attachment[%] missing name', i;
    END IF;
    IF (p_attachments->i->>'mime') IS NULL THEN
      RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: attachment[%] missing mime', i;
    END IF;
  END LOOP;
END
$cl_payload$;

REVOKE ALL ON FUNCTION public._cattle_log_validate_payload(uuid, text, uuid[], jsonb) FROM PUBLIC, anon, authenticated;

-- Validate the calf-note fields supplied for an unmatched tag. Each field is
-- validated only when provided (missing calf notes are accepted: the offline
-- replay path may omit them; the online flow enforces required fields
-- client-side).
CREATE OR REPLACE FUNCTION public._cattle_log_validate_calf_note(
  p_tag  text,
  p_note jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $cl_calf$
DECLARE
  v_val text;
BEGIN
  IF p_note IS NULL OR jsonb_typeof(p_note) = 'null' THEN
    RETURN;
  END IF;
  IF jsonb_typeof(p_note) <> 'object' THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: calf note for tag #% must be an object', p_tag;
  END IF;

  v_val := NULLIF(btrim(COALESCE(p_note->>'calf_herd', '')), '');
  IF v_val IS NOT NULL AND v_val NOT IN ('mommas', 'backgrounders', 'finishers', 'bulls') THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: invalid calf herd % for tag #%', v_val, p_tag;
  END IF;

  v_val := NULLIF(btrim(COALESCE(p_note->>'calf_sex', '')), '');
  IF v_val IS NOT NULL AND v_val NOT IN ('cow', 'heifer', 'bull', 'steer') THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: invalid calf sex % for tag #%', v_val, p_tag;
  END IF;

  v_val := NULLIF(btrim(COALESCE(p_note->>'calf_dob', '')), '');
  IF v_val IS NOT NULL THEN
    BEGIN
      PERFORM v_val::date;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: invalid calf DOB % for tag #%', v_val, p_tag;
    END;
  END IF;

  v_val := NULLIF(btrim(COALESCE(p_note->>'calf_dob_estimated', '')), '');
  IF v_val IS NOT NULL THEN
    BEGIN
      PERFORM v_val::boolean;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: invalid calf DOB estimated flag % for tag #%', v_val, p_tag;
    END;
  END IF;

  v_val := NULLIF(btrim(COALESCE(p_note->>'calf_origin', '')), '');
  IF v_val IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.cattle c WHERE c.origin = v_val
  ) THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: unknown calf origin % for tag #%', v_val, p_tag;
  END IF;

  v_val := NULLIF(btrim(COALESCE(p_note->>'calf_breed', '')), '');
  IF v_val IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.cattle c WHERE c.breed = v_val
  ) THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: unknown calf breed % for tag #%', v_val, p_tag;
  END IF;

  v_val := NULLIF(btrim(COALESCE(p_note->>'calf_dam_tag', '')), '');
  IF v_val IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.cattle c
     WHERE c.deleted_at IS NULL
       AND c.herd IN ('mommas', 'backgrounders', 'finishers', 'bulls')
       AND c.tag = v_val
  ) THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: calf dam tag % does not match an active cow for tag #%', v_val, p_tag;
  END IF;
END
$cl_calf$;

REVOKE ALL ON FUNCTION public._cattle_log_validate_calf_note(text, jsonb) FROM PUBLIC, anon, authenticated;

-- Insert an unresolved link row, attaching calf-note fields when present.
-- Caller validates the note first (_cattle_log_validate_calf_note).
CREATE OR REPLACE FUNCTION public._cattle_log_insert_unresolved_link(
  p_comment_id text,
  p_tag        text,
  p_note       jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $cl_unres$
BEGIN
  INSERT INTO public.cattle_log_tag_links
    (id, comment_id, tag, cattle_id, mirror_comment_id,
     calf_herd, calf_dob, calf_dob_estimated, calf_sex,
     calf_origin, calf_dam_tag, calf_breed, calf_note)
  VALUES
    ('cll-' || gen_random_uuid()::text, p_comment_id, p_tag, NULL, NULL,
     NULLIF(btrim(COALESCE(p_note->>'calf_herd', '')), ''),
     (NULLIF(btrim(COALESCE(p_note->>'calf_dob', '')), ''))::date,
     (NULLIF(btrim(COALESCE(p_note->>'calf_dob_estimated', '')), ''))::boolean,
     NULLIF(btrim(COALESCE(p_note->>'calf_sex', '')), ''),
     NULLIF(btrim(COALESCE(p_note->>'calf_origin', '')), ''),
     NULLIF(btrim(COALESCE(p_note->>'calf_dam_tag', '')), ''),
     NULLIF(btrim(COALESCE(p_note->>'calf_breed', '')), ''),
     NULLIF(btrim(COALESCE(p_note->>'calf_note', '')), ''));
END
$cl_unres$;

REVOKE ALL ON FUNCTION public._cattle_log_insert_unresolved_link(text, text, jsonb) FROM PUBLIC, anon, authenticated;

-- Mention notification fan-out, copying the mig 071 post_comment shape with
-- the fixed Cattle Log entity. p_previous (edit path) suppresses re-notifying
-- already-mentioned profiles, matching edit_comment behavior.
CREATE OR REPLACE FUNCTION public._cattle_log_notify_mentions(
  p_comment_id text,
  p_actor      uuid,
  p_body       text,
  p_mentions   uuid[],
  p_previous   uuid[]
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $cl_notify$
DECLARE
  v_actor_name text;
  v_m          uuid;
  v_skip       uuid[] := COALESCE(p_previous, ARRAY[]::uuid[]);
BEGIN
  IF COALESCE(array_length(p_mentions, 1), 0) = 0 THEN
    RETURN;
  END IF;

  SELECT COALESCE(full_name, '') INTO v_actor_name
    FROM public.profiles WHERE id = p_actor;
  IF v_actor_name IS NULL OR length(btrim(v_actor_name)) = 0 THEN
    v_actor_name := 'Someone';
  END IF;

  FOREACH v_m IN ARRAY p_mentions LOOP
    IF v_m = ANY(v_skip) THEN
      CONTINUE;
    END IF;
    INSERT INTO public.notifications
      (id, recipient_profile_id, actor_profile_id, type,
       comment_entity_type, comment_entity_id, comment_entity_label,
       comment_id, title, body, created_at)
    VALUES
      ('ntf-' || gen_random_uuid()::text, v_m, p_actor, 'comment_mention',
       'cattle.log', 'cattle-log', 'Cattle Log',
       p_comment_id, v_actor_name || ' mentioned you in a comment on Cattle Log',
       left(p_body, 200), now());
  END LOOP;
END
$cl_notify$;

REVOKE ALL ON FUNCTION public._cattle_log_notify_mentions(text, uuid, text, uuid[], uuid[]) FROM PUBLIC, anon, authenticated;

-- ── 4. submit_cattle_log_entry ──────────────────────────────────────────────
-- Replay-idempotent create (offline queue calls this with the same client id
-- until it lands). Parses #tags server-side; matched tags get link + mirror,
-- unmatched tags get unresolved links (+ optional calf-note fields) and force
-- is_issue true. Ambiguous tags hard-fail.

CREATE OR REPLACE FUNCTION public.submit_cattle_log_entry(
  p_id          text,
  p_body        text,
  p_mentions    uuid[] DEFAULT '{}'::uuid[],
  p_attachments jsonb DEFAULT '[]'::jsonb,
  p_is_issue    boolean DEFAULT true,
  p_calf_notes  jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $cl_submit$
DECLARE
  v_caller      uuid := auth.uid();
  v_role        text;
  v_mentions    uuid[] := COALESCE(p_mentions, ARRAY[]::uuid[]);
  v_attachments jsonb := COALESCE(p_attachments, '[]'::jsonb);
  v_calf_notes  jsonb := COALESCE(p_calf_notes, '{}'::jsonb);
  v_created_at  timestamptz := now();
  v_is_issue    boolean;
  v_tags        text[];
  v_tag         text;
  v_note        jsonb;
  v_ids         text[];
  v_n           int;
  v_mirror_id   text;
  v_matched     jsonb := '[]'::jsonb;
  v_unresolved  text[] := ARRAY[]::text[];
BEGIN
  -- Deliberately unprefixed: an expired session during offline replay must
  -- classify transient (stay queued), not needs-attention.
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'submit_cattle_log_entry: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('light', 'farm_team', 'management', 'admin') THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: caller role % cannot use the cattle log', COALESCE(v_role, 'null');
  END IF;

  -- Replay idempotency: if this id already landed as a cattle.log entry,
  -- return its summary instead of erroring.
  IF EXISTS (SELECT 1 FROM public.comments WHERE id = p_id) THEN
    SELECT c.created_at, COALESCE(s.is_issue, true)
      INTO v_created_at, v_is_issue
      FROM public.comments c
      LEFT JOIN public.cattle_log_issue_state s ON s.comment_id = c.id
     WHERE c.id = p_id
       AND c.entity_type = 'cattle.log'
       AND c.entity_id = 'cattle-log';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: id % is already used by another comment', p_id;
    END IF;

    SELECT
      COALESCE(array_agg(l.tag ORDER BY l.created_at, l.tag) FILTER (WHERE l.cattle_id IS NULL), ARRAY[]::text[]),
      COALESCE(jsonb_agg(jsonb_build_object('tag', l.tag, 'cattle_id', l.cattle_id) ORDER BY l.created_at, l.tag)
        FILTER (WHERE l.cattle_id IS NOT NULL), '[]'::jsonb)
      INTO v_unresolved, v_matched
      FROM public.cattle_log_tag_links l
     WHERE l.comment_id = p_id;

    RETURN jsonb_build_object(
      'id', p_id,
      'created_at', v_created_at,
      'is_issue', v_is_issue,
      'unresolved_tags', to_jsonb(v_unresolved),
      'matched', v_matched,
      'replayed', true
    );
  END IF;

  -- Entry id sanity: client mints 'cl-<base36>-<base36>'. Mirror ids are
  -- 'clog-<entryId>--<cattleId>', so entry ids must never start with 'clog-'
  -- and must never contain '--'.
  IF p_id IS NULL OR length(btrim(p_id)) = 0 THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: entry id required';
  END IF;
  IF p_id LIKE 'clog-%' THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: entry id must not start with clog-';
  END IF;
  IF position('--' in p_id) > 0 THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: entry id must not contain --';
  END IF;
  IF p_id !~ '^[A-Za-z0-9-]+$' OR length(p_id) > 100 THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: invalid entry id';
  END IF;

  PERFORM public._cattle_log_validate_payload(v_caller, p_body, v_mentions, v_attachments);

  IF jsonb_typeof(v_calf_notes) <> 'object' THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: calf notes must be a JSON object';
  END IF;

  INSERT INTO public.comments
    (id, entity_type, entity_id, author_profile_id, body, mentions, attachments, created_at)
  VALUES
    (p_id, 'cattle.log', 'cattle-log', v_caller, p_body, v_mentions, v_attachments, v_created_at);

  v_tags := public._cattle_log_parse_tags(p_body);
  FOREACH v_tag IN ARRAY v_tags LOOP
    v_ids := public._cattle_log_match_tag(v_tag);
    v_n := COALESCE(array_length(v_ids, 1), 0);
    IF v_n > 1 THEN
      RAISE EXCEPTION 'CATTLE_LOG_AMBIGUOUS_TAG: %', v_tag;
    ELSIF v_n = 1 THEN
      v_mirror_id := public._cattle_log_upsert_mirror(p_id, v_ids[1], v_caller, p_body, v_attachments);
      INSERT INTO public.cattle_log_tag_links
        (id, comment_id, tag, cattle_id, mirror_comment_id)
      VALUES
        ('cll-' || gen_random_uuid()::text, p_id, v_tag, v_ids[1], v_mirror_id);
      v_matched := v_matched || jsonb_build_array(jsonb_build_object('tag', v_tag, 'cattle_id', v_ids[1]));
    ELSE
      v_note := v_calf_notes -> v_tag;
      IF v_note IS NOT NULL THEN
        PERFORM public._cattle_log_validate_calf_note(v_tag, v_note);
      END IF;
      PERFORM public._cattle_log_insert_unresolved_link(p_id, v_tag, v_note);
      v_unresolved := array_append(v_unresolved, v_tag);
    END IF;
  END LOOP;

  -- Unmatched tags FORCE is_issue true server-side.
  v_is_issue := COALESCE(p_is_issue, true) OR COALESCE(array_length(v_unresolved, 1), 0) > 0;

  INSERT INTO public.cattle_log_issue_state
    (comment_id, is_issue, last_set_by, last_set_at)
  VALUES
    (p_id, v_is_issue, v_caller, now())
  ON CONFLICT (comment_id) DO UPDATE
    SET is_issue = EXCLUDED.is_issue,
        last_set_by = EXCLUDED.last_set_by,
        last_set_at = EXCLUDED.last_set_at;

  PERFORM public._cattle_log_notify_mentions(p_id, v_caller, p_body, v_mentions, NULL);

  RETURN jsonb_build_object(
    'id', p_id,
    'created_at', v_created_at,
    'is_issue', v_is_issue,
    'unresolved_tags', to_jsonb(v_unresolved),
    'matched', v_matched,
    'replayed', false
  );
END
$cl_submit$;

REVOKE ALL ON FUNCTION public.submit_cattle_log_entry(text, text, uuid[], jsonb, boolean, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_cattle_log_entry(text, text, uuid[], jsonb, boolean, jsonb) TO authenticated;

-- ── 5. edit_cattle_log_entry ────────────────────────────────────────────────
-- Author-only. Records the previous version into comment_edits (mig 071
-- behavior, incl. notifying only NEWLY added mentions), re-parses tags and
-- diffs against existing links: removed tag -> link deleted + mirror hard-
-- deleted; new matched tag -> link + mirror; new unmatched tag -> unresolved
-- link (forces is_issue true). Surviving mirrors are resynced (body,
-- attachments, edited_at).
--
-- p_mentions semantics:
--   NULL (default) -> PRESERVE the existing mentions unchanged and send no
--                     new mention notifications (existing mentions are not
--                     re-validated; they were validated when set).
--   '{}'           -> remove all mentions.
--   non-empty      -> authoritative full set: validate, diff against the
--                     previous set, notify only NEWLY added mentions.

CREATE OR REPLACE FUNCTION public.edit_cattle_log_entry(
  p_id          text,
  p_body        text,
  p_mentions    uuid[] DEFAULT NULL,
  p_attachments jsonb DEFAULT '[]'::jsonb,
  p_calf_notes  jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $cl_edit$
DECLARE
  v_caller      uuid := auth.uid();
  v_role        text;
  v_row         record;
  v_link        record;
  v_mentions    uuid[];
  v_attachments jsonb := COALESCE(p_attachments, '[]'::jsonb);
  v_calf_notes  jsonb := COALESCE(p_calf_notes, '{}'::jsonb);
  v_edited_at   timestamptz := now();
  v_tags        text[];
  v_tag         text;
  v_note        jsonb;
  v_ids         text[];
  v_n           int;
  v_mirror_id   text;
  v_matched     jsonb := '[]'::jsonb;
  v_unresolved  text[] := ARRAY[]::text[];
  v_is_issue    boolean;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'edit_cattle_log_entry: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('light', 'farm_team', 'management', 'admin') THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: caller role % cannot use the cattle log', COALESCE(v_role, 'null');
  END IF;

  IF p_id LIKE 'clog-%' THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: cattle log mirrors are managed by the Cattle Log RPCs';
  END IF;

  SELECT id, entity_type, entity_id, author_profile_id, body, mentions, attachments, deleted_at
    INTO v_row
    FROM public.comments
   WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: entry % not found', p_id;
  END IF;
  IF v_row.entity_type <> 'cattle.log' OR v_row.entity_id <> 'cattle-log' THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: % is not a cattle log entry', p_id;
  END IF;
  IF v_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: entry % is deleted', p_id;
  END IF;
  IF v_row.author_profile_id IS DISTINCT FROM v_caller THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: only the author may edit';
  END IF;

  -- p_mentions NULL means PRESERVE the existing mentions unchanged; an empty
  -- array means remove all. Preserved mentions are not re-validated (they
  -- were validated when set), so validation sees an empty mention list.
  IF p_mentions IS NULL THEN
    v_mentions := COALESCE(v_row.mentions, ARRAY[]::uuid[]);
  ELSE
    v_mentions := p_mentions;
  END IF;

  PERFORM public._cattle_log_validate_payload(
    v_caller, p_body,
    CASE WHEN p_mentions IS NULL THEN ARRAY[]::uuid[] ELSE v_mentions END,
    v_attachments);

  IF jsonb_typeof(v_calf_notes) <> 'object' THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: calf notes must be a JSON object';
  END IF;

  -- Save the previous version to edit history (mig 071 pattern).
  INSERT INTO public.comment_edits
    (id, comment_id, previous_body, previous_attachments, edited_by, edited_at)
  VALUES
    ('cedit-' || gen_random_uuid()::text, p_id, v_row.body, v_row.attachments, v_caller, v_edited_at);

  UPDATE public.comments
     SET body = p_body,
         mentions = v_mentions,
         attachments = v_attachments,
         edited_at = v_edited_at
   WHERE id = p_id;

  -- Notify only NEWLY added mentions (edit_comment behavior). A NULL
  -- p_mentions preserves the existing set, so there is nothing new to
  -- notify — skip the fan-out entirely.
  IF p_mentions IS NOT NULL THEN
    PERFORM public._cattle_log_notify_mentions(p_id, v_caller, p_body, v_mentions, v_row.mentions);
  END IF;

  v_tags := public._cattle_log_parse_tags(p_body);

  -- Removed tags: hard-delete the mirror, then drop the link row.
  FOR v_link IN
    SELECT l.id, l.mirror_comment_id
      FROM public.cattle_log_tag_links l
     WHERE l.comment_id = p_id
       AND NOT (l.tag = ANY(v_tags))
  LOOP
    IF v_link.mirror_comment_id IS NOT NULL THEN
      DELETE FROM public.comments WHERE id = v_link.mirror_comment_id;
    END IF;
    DELETE FROM public.cattle_log_tag_links WHERE id = v_link.id;
  END LOOP;

  -- Surviving + new tags.
  FOREACH v_tag IN ARRAY v_tags LOOP
    SELECT l.id, l.cattle_id, l.mirror_comment_id
      INTO v_link
      FROM public.cattle_log_tag_links l
     WHERE l.comment_id = p_id AND l.tag = v_tag;

    IF FOUND THEN
      -- Existing unresolved link: refresh calf-note fields when supplied.
      IF v_link.cattle_id IS NULL THEN
        v_note := v_calf_notes -> v_tag;
        IF v_note IS NOT NULL AND jsonb_typeof(v_note) = 'object' THEN
          PERFORM public._cattle_log_validate_calf_note(v_tag, v_note);
          UPDATE public.cattle_log_tag_links
             SET calf_herd = NULLIF(btrim(COALESCE(v_note->>'calf_herd', '')), ''),
                 calf_dob = (NULLIF(btrim(COALESCE(v_note->>'calf_dob', '')), ''))::date,
                 calf_dob_estimated = (NULLIF(btrim(COALESCE(v_note->>'calf_dob_estimated', '')), ''))::boolean,
                 calf_sex = NULLIF(btrim(COALESCE(v_note->>'calf_sex', '')), ''),
                 calf_origin = NULLIF(btrim(COALESCE(v_note->>'calf_origin', '')), ''),
                 calf_dam_tag = NULLIF(btrim(COALESCE(v_note->>'calf_dam_tag', '')), ''),
                 calf_breed = NULLIF(btrim(COALESCE(v_note->>'calf_breed', '')), ''),
                 calf_note = NULLIF(btrim(COALESCE(v_note->>'calf_note', '')), ''),
                 updated_at = now()
           WHERE id = v_link.id;
        END IF;
      END IF;
    ELSE
      v_ids := public._cattle_log_match_tag(v_tag);
      v_n := COALESCE(array_length(v_ids, 1), 0);
      IF v_n > 1 THEN
        RAISE EXCEPTION 'CATTLE_LOG_AMBIGUOUS_TAG: %', v_tag;
      ELSIF v_n = 1 THEN
        v_mirror_id := public._cattle_log_upsert_mirror(p_id, v_ids[1], v_row.author_profile_id, p_body, v_attachments);
        INSERT INTO public.cattle_log_tag_links
          (id, comment_id, tag, cattle_id, mirror_comment_id)
        VALUES
          ('cll-' || gen_random_uuid()::text, p_id, v_tag, v_ids[1], v_mirror_id);
      ELSE
        v_note := v_calf_notes -> v_tag;
        IF v_note IS NOT NULL THEN
          PERFORM public._cattle_log_validate_calf_note(v_tag, v_note);
        END IF;
        PERFORM public._cattle_log_insert_unresolved_link(p_id, v_tag, v_note);
      END IF;
    END IF;
  END LOOP;

  -- Resync all surviving mirrors (body, attachments, edited_at). Also
  -- self-heals a resolved link whose mirror row went missing.
  FOR v_link IN
    SELECT l.id, l.cattle_id, l.mirror_comment_id
      FROM public.cattle_log_tag_links l
     WHERE l.comment_id = p_id AND l.cattle_id IS NOT NULL
  LOOP
    v_mirror_id := public._cattle_log_upsert_mirror(p_id, v_link.cattle_id, v_row.author_profile_id, p_body, v_attachments);
    IF v_link.mirror_comment_id IS DISTINCT FROM v_mirror_id THEN
      UPDATE public.cattle_log_tag_links
         SET mirror_comment_id = v_mirror_id, updated_at = now()
       WHERE id = v_link.id;
    END IF;
  END LOOP;

  -- Any unresolved link forces is_issue true (never auto-clears).
  IF EXISTS (
    SELECT 1 FROM public.cattle_log_tag_links
     WHERE comment_id = p_id AND cattle_id IS NULL
  ) THEN
    INSERT INTO public.cattle_log_issue_state
      (comment_id, is_issue, last_set_by, last_set_at)
    VALUES
      (p_id, true, v_caller, now())
    ON CONFLICT (comment_id) DO UPDATE
      SET is_issue = true,
          last_set_by = EXCLUDED.last_set_by,
          last_set_at = EXCLUDED.last_set_at
      WHERE public.cattle_log_issue_state.is_issue IS DISTINCT FROM true;
  END IF;

  SELECT
    COALESCE(array_agg(l.tag ORDER BY l.created_at, l.tag) FILTER (WHERE l.cattle_id IS NULL), ARRAY[]::text[]),
    COALESCE(jsonb_agg(jsonb_build_object('tag', l.tag, 'cattle_id', l.cattle_id) ORDER BY l.created_at, l.tag)
      FILTER (WHERE l.cattle_id IS NOT NULL), '[]'::jsonb)
    INTO v_unresolved, v_matched
    FROM public.cattle_log_tag_links l
   WHERE l.comment_id = p_id;

  v_is_issue := COALESCE(
    (SELECT is_issue FROM public.cattle_log_issue_state WHERE comment_id = p_id),
    true
  );

  RETURN jsonb_build_object(
    'id', p_id,
    'edited_at', v_edited_at,
    'is_issue', v_is_issue,
    'unresolved_tags', to_jsonb(v_unresolved),
    'matched', v_matched
  );
END
$cl_edit$;

REVOKE ALL ON FUNCTION public.edit_cattle_log_entry(text, text, uuid[], jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.edit_cattle_log_entry(text, text, uuid[], jsonb, jsonb) TO authenticated;

-- ── 6. delete_cattle_log_entry ──────────────────────────────────────────────
-- management/admin only. Soft-deletes the original; hard-deletes its mirrors
-- (mirror_comment_id cleared on links). Link/issue rows are kept — their FK
-- cascade only fires on a hard delete of the original.

CREATE OR REPLACE FUNCTION public.delete_cattle_log_entry(
  p_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $cl_delete$
DECLARE
  v_caller uuid := auth.uid();
  v_role   text;
  v_row    record;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'delete_cattle_log_entry: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('management', 'admin') THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: caller role % cannot delete log entries', COALESCE(v_role, 'null');
  END IF;

  IF p_id LIKE 'clog-%' THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: cattle log mirrors are managed by the Cattle Log RPCs';
  END IF;

  SELECT id, entity_type, entity_id, deleted_at
    INTO v_row
    FROM public.comments
   WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: entry % not found', p_id;
  END IF;
  IF v_row.entity_type <> 'cattle.log' OR v_row.entity_id <> 'cattle-log' THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: % is not a cattle log entry', p_id;
  END IF;
  IF v_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: entry % already deleted', p_id;
  END IF;

  UPDATE public.comments
     SET deleted_at = now(),
         deleted_by = v_caller
   WHERE id = p_id;

  DELETE FROM public.comments
   WHERE id IN (
     SELECT l.mirror_comment_id
       FROM public.cattle_log_tag_links l
      WHERE l.comment_id = p_id
        AND l.mirror_comment_id IS NOT NULL
   );

  UPDATE public.cattle_log_tag_links
     SET mirror_comment_id = NULL,
         updated_at = now()
   WHERE comment_id = p_id
     AND mirror_comment_id IS NOT NULL;

  RETURN jsonb_build_object('ok', true, 'id', p_id);
END
$cl_delete$;

REVOKE ALL ON FUNCTION public.delete_cattle_log_entry(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_cattle_log_entry(text) TO authenticated;

-- ── 7. set_cattle_log_issue ─────────────────────────────────────────────────
-- management/admin only. Both directions allowed (clear and re-check).

CREATE OR REPLACE FUNCTION public.set_cattle_log_issue(
  p_id       text,
  p_is_issue boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $cl_issue$
DECLARE
  v_caller uuid := auth.uid();
  v_role   text;
  v_row    record;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'set_cattle_log_issue: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('management', 'admin') THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: caller role % cannot toggle issue state', COALESCE(v_role, 'null');
  END IF;

  IF p_is_issue IS NULL THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: is_issue required';
  END IF;

  SELECT id, entity_type, entity_id, deleted_at
    INTO v_row
    FROM public.comments
   WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: entry % not found', p_id;
  END IF;
  IF v_row.entity_type <> 'cattle.log' OR v_row.entity_id <> 'cattle-log' THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: % is not a cattle log entry', p_id;
  END IF;
  IF v_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: entry % is deleted', p_id;
  END IF;

  INSERT INTO public.cattle_log_issue_state
    (comment_id, is_issue, last_set_by, last_set_at)
  VALUES
    (p_id, p_is_issue, v_caller, now())
  ON CONFLICT (comment_id) DO UPDATE
    SET is_issue = EXCLUDED.is_issue,
        last_set_by = EXCLUDED.last_set_by,
        last_set_at = EXCLUDED.last_set_at;

  RETURN jsonb_build_object('ok', true, 'id', p_id, 'is_issue', p_is_issue);
END
$cl_issue$;

REVOKE ALL ON FUNCTION public.set_cattle_log_issue(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_cattle_log_issue(text, boolean) TO authenticated;

-- ── 8. list_cattle_log_entries ──────────────────────────────────────────────
-- Server-side search over the FULL history: body ILIKE, author name ILIKE, or
-- exact tag-link match when the query (leading '#'s stripped) is all digits.
-- Newest-first keyset pagination on (created_at DESC, id DESC). Soft-deleted
-- entries excluded. Mirrors never appear here (they live on cow pages, under
-- entity_type 'cattle.animal').

CREATE OR REPLACE FUNCTION public.list_cattle_log_entries(
  p_filter            text DEFAULT 'issues',
  p_search            text DEFAULT NULL,
  p_limit             int DEFAULT 200,
  p_before_created_at timestamptz DEFAULT NULL,
  p_before_id         text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $cl_list$
DECLARE
  v_caller   uuid := auth.uid();
  v_role     text;
  v_filter   text := COALESCE(NULLIF(btrim(COALESCE(p_filter, '')), ''), 'issues');
  v_search   text := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_tag_q    text;
  v_limit    int := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
  v_entries  jsonb;
  v_has_more boolean := false;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'list_cattle_log_entries: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('light', 'farm_team', 'management', 'admin') THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: caller role % cannot read the cattle log', COALESCE(v_role, 'null');
  END IF;

  IF v_filter NOT IN ('issues', 'all') THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: unknown filter %', v_filter;
  END IF;

  -- '#123' and '123' both search tag links; '#0123' stays distinct from '#123'.
  IF v_search IS NOT NULL THEN
    v_tag_q := ltrim(v_search, '#');
    IF v_tag_q !~ '^[0-9]+$' THEN
      v_tag_q := NULL;
    END IF;
  END IF;

  WITH page AS (
    SELECT
      c.id,
      c.body,
      c.author_profile_id,
      COALESCE(c.mentions, ARRAY[]::uuid[]) AS mentions,
      COALESCE(c.attachments, '[]'::jsonb) AS attachments,
      c.created_at,
      c.edited_at,
      COALESCE(s.is_issue, true) AS is_issue,
      COALESCE(p.full_name, 'Unknown user') AS author_name
    FROM public.comments c
    LEFT JOIN public.cattle_log_issue_state s ON s.comment_id = c.id
    LEFT JOIN public.profiles p ON p.id = c.author_profile_id
    WHERE c.entity_type = 'cattle.log'
      AND c.entity_id = 'cattle-log'
      AND c.deleted_at IS NULL
      AND (v_filter = 'all' OR COALESCE(s.is_issue, true))
      AND (
        v_search IS NULL
        OR c.body ILIKE '%' || v_search || '%'
        OR COALESCE(p.full_name, '') ILIKE '%' || v_search || '%'
        OR (v_tag_q IS NOT NULL AND EXISTS (
              SELECT 1 FROM public.cattle_log_tag_links l
               WHERE l.comment_id = c.id AND l.tag = v_tag_q
            ))
      )
      AND (
        p_before_created_at IS NULL
        OR (p_before_id IS NULL AND c.created_at < p_before_created_at)
        OR (p_before_id IS NOT NULL AND (c.created_at, c.id) < (p_before_created_at, p_before_id))
      )
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT v_limit + 1
  ),
  trimmed AS (
    SELECT * FROM page ORDER BY created_at DESC, id DESC LIMIT v_limit
  )
  SELECT
    (SELECT count(*) FROM page) > v_limit,
    COALESCE(jsonb_agg(jsonb_build_object(
      'id', t.id,
      'body', t.body,
      'author_profile_id', t.author_profile_id,
      'author_name', t.author_name,
      'created_at', t.created_at,
      'edited_at', t.edited_at,
      'is_issue', t.is_issue,
      'mentioned_profile_names', (
        SELECT COALESCE(jsonb_agg(COALESCE(mp.full_name, 'Unknown') ORDER BY m.ord), '[]'::jsonb)
        FROM unnest(t.mentions) WITH ORDINALITY AS m(uid, ord)
        LEFT JOIN public.profiles mp ON mp.id = m.uid
      ),
      'attachments', t.attachments,
      'tags', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'tag', l.tag,
          'cattle_id', l.cattle_id,
          'mirror_comment_id', l.mirror_comment_id,
          'resolved', (l.cattle_id IS NOT NULL),
          'calf_herd', l.calf_herd,
          'calf_dob', l.calf_dob,
          'calf_dob_estimated', l.calf_dob_estimated,
          'calf_sex', l.calf_sex,
          'calf_origin', l.calf_origin,
          'calf_dam_tag', l.calf_dam_tag,
          'calf_breed', l.calf_breed,
          'calf_note', l.calf_note
        ) ORDER BY l.created_at, l.tag), '[]'::jsonb)
        FROM public.cattle_log_tag_links l
        WHERE l.comment_id = t.id
      )
    ) ORDER BY t.created_at DESC, t.id DESC), '[]'::jsonb)
    INTO v_has_more, v_entries
  FROM trimmed t;

  RETURN jsonb_build_object('entries', v_entries, 'has_more', v_has_more);
END
$cl_list$;

REVOKE ALL ON FUNCTION public.list_cattle_log_entries(text, text, int, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_cattle_log_entries(text, text, int, timestamptz, text) TO authenticated;

-- ── 9. list_cattle_log_mentionable_profiles ─────────────────────────────────
-- Active profiles in the Cattle Log role set only (narrower than the generic
-- list_comment_mentionable_profiles, which includes equipment_tech).

CREATE OR REPLACE FUNCTION public.list_cattle_log_mentionable_profiles()
RETURNS TABLE (id uuid, full_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $cl_mention$
DECLARE
  v_caller uuid := auth.uid();
  v_role   text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'list_cattle_log_mentionable_profiles: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('light', 'farm_team', 'management', 'admin') THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: caller role % cannot read the cattle log', COALESCE(v_role, 'null');
  END IF;

  RETURN QUERY
  SELECT p.id, p.full_name
    FROM public.profiles p
   WHERE p.role IN ('light', 'farm_team', 'management', 'admin')
     AND p.full_name IS NOT NULL
     AND length(btrim(p.full_name)) > 0
   ORDER BY p.full_name;
END
$cl_mention$;

REVOKE ALL ON FUNCTION public.list_cattle_log_mentionable_profiles() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_cattle_log_mentionable_profiles() TO authenticated;

-- ── 10. Resolver: late tag matches on cattle INSERT/retag ───────────────────
-- When a cow is added or retagged, unresolved links whose tag now matches the
-- NEW row are re-checked. The authoritative global match (current tag first,
-- then non-import old_tags, active cattle only) must be UNAMBIGUOUS; the link
-- then gets its mirror + cattle_id. Skips soft-deleted originals. Never
-- touches is_issue. SECURITY DEFINER because cattle writes also come from
-- anon (weigh-in webform) which has no privileges on comments/log tables.
-- Exception-guarded (mig 111 pattern) so a resolver failure never blocks a
-- cattle write.

CREATE OR REPLACE FUNCTION public.resolve_cattle_log_unresolved_tags()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $cl_resolver$
DECLARE
  v_link      record;
  v_ids       text[];
  v_mirror_id text;
BEGIN
  -- Only an ACTIVE row can introduce new matches.
  IF NEW.deleted_at IS NOT NULL
     OR NEW.herd IS NULL
     OR NEW.herd NOT IN ('mommas', 'backgrounders', 'finishers', 'bulls') THEN
    RETURN NEW;
  END IF;

  FOR v_link IN
    SELECT l.id, l.comment_id, l.tag, c.author_profile_id, c.body, c.attachments
      FROM public.cattle_log_tag_links l
      JOIN public.comments c ON c.id = l.comment_id
     WHERE l.cattle_id IS NULL
       AND c.deleted_at IS NULL
       AND (
         l.tag = NEW.tag
         OR EXISTS (
           SELECT 1
             FROM jsonb_array_elements(COALESCE(NEW.old_tags, '[]'::jsonb)) AS ot
            WHERE ot->>'tag' = l.tag
              AND COALESCE(ot->>'source', '') <> 'import'
         )
       )
  LOOP
    v_ids := public._cattle_log_match_tag(v_link.tag);
    IF COALESCE(array_length(v_ids, 1), 0) <> 1 THEN
      CONTINUE; -- still unmatched, or ambiguous: leave unresolved
    END IF;
    v_mirror_id := public._cattle_log_upsert_mirror(
      v_link.comment_id, v_ids[1], v_link.author_profile_id, v_link.body, v_link.attachments);
    UPDATE public.cattle_log_tag_links
       SET cattle_id = v_ids[1],
           mirror_comment_id = v_mirror_id,
           updated_at = now()
     WHERE id = v_link.id;
  END LOOP;

  RETURN NEW;
EXCEPTION WHEN others THEN
  RAISE WARNING 'resolve_cattle_log_unresolved_tags failed for cattle %: %', NEW.id, SQLERRM;
  RETURN NEW;
END
$cl_resolver$;

REVOKE ALL ON FUNCTION public.resolve_cattle_log_unresolved_tags() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS cattle_log_tag_resolver ON public.cattle;
CREATE TRIGGER cattle_log_tag_resolver
AFTER INSERT OR UPDATE OF tag, old_tags
ON public.cattle
FOR EACH ROW
EXECUTE FUNCTION public.resolve_cattle_log_unresolved_tags();

-- ── 11. Mirror guard: edit_comment ──────────────────────────────────────────
-- Faithful re-issue of the LATEST definition (mig 071; no later redefinition
-- exists) with ONE added early clause: 'clog-' mirrors (or any id recorded in
-- cattle_log_tag_links.mirror_comment_id) are managed exclusively by the
-- Cattle Log RPCs.

CREATE OR REPLACE FUNCTION public.edit_comment(
  p_comment_id   text,
  p_body         text,
  p_mentions     uuid[] DEFAULT ARRAY[]::uuid[],
  p_attachments  jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
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
  -- edit_cattle_log_entry (tag re-diff + mirror resync); the id-based mirror
  -- guard above does NOT cover originals (mirrors live on cattle.animal).
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
$fn$;

REVOKE ALL ON FUNCTION public.edit_comment(text, text, uuid[], jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.edit_comment(text, text, uuid[], jsonb) TO authenticated;

-- ── 12. Mirror guard: delete_comment ────────────────────────────────────────
-- Faithful re-issue of the LATEST definition (mig 071; no later redefinition
-- exists) with the same early mirror-guard clause.

CREATE OR REPLACE FUNCTION public.delete_comment(
  p_comment_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_role   text;
  v_row    record;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'delete_comment: authenticated caller required';
  END IF;

  -- Cattle Log mirror guard (mig 112).
  IF p_comment_id LIKE 'clog-%' OR EXISTS (
    SELECT 1 FROM public.cattle_log_tag_links
     WHERE mirror_comment_id = p_comment_id
  ) THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: cattle log mirrors are managed by the Cattle Log RPCs';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role = 'inactive' THEN
    RAISE EXCEPTION 'delete_comment: caller role % cannot delete', COALESCE(v_role, 'null');
  END IF;

  SELECT id, entity_type, entity_id, author_profile_id, deleted_at
    INTO v_row
    FROM public.comments
    WHERE id = p_comment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'delete_comment: comment % not found', p_comment_id;
  END IF;
  IF v_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'delete_comment: comment % already deleted', p_comment_id;
  END IF;
  -- Cattle Log originals guard (mig 112): deletes of 'cl-…' log entries are
  -- management/admin-only via delete_cattle_log_entry (which also clears
  -- mirrors); the id-based mirror guard above does NOT cover originals.
  IF v_row.entity_type = 'cattle.log' THEN
    RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: cattle log entries are managed by the Cattle Log RPCs';
  END IF;

  IF NOT public._activity_can_write(v_row.entity_type, v_row.entity_id) THEN
    RAISE EXCEPTION 'delete_comment: not permitted for entity';
  END IF;

  IF v_row.author_profile_id IS DISTINCT FROM v_caller AND v_role <> 'admin' THEN
    RAISE EXCEPTION 'delete_comment: only author or admin may delete';
  END IF;

  UPDATE public.comments
    SET deleted_at = now(),
        deleted_by = v_caller
    WHERE id = p_comment_id;

  RETURN jsonb_build_object('ok', true, 'comment_id', p_comment_id);
END
$fn$;

REVOKE ALL ON FUNCTION public.delete_comment(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_comment(text) TO authenticated;

-- ── 13. _activity_can_read: add 'cattle.log' branch ─────────────────────────
-- Faithful re-issue of the LATEST definition (mig 078) preserving every
-- existing branch, adding the cattle.log branch before the fail-closed
-- default. The new branch is an EXPLICIT role gate (light/farm_team/
-- management/admin), NOT profile_program_access.

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

  -- Unknown entity_type. Fail closed.
  RETURN false;
END
$can_read$;

REVOKE ALL ON FUNCTION public._activity_can_read(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._activity_can_read(text, text) TO authenticated;

-- ── 14. _activity_can_write: add 'cattle.log' branch ────────────────────────
-- Faithful re-issue of the LATEST definition (mig 062) with a cattle.log
-- branch ahead of the delegation to _activity_can_read. The branch returns
-- FALSE: writes to cattle.log go exclusively through the Cattle Log RPC
-- family (a permissive branch would let generic post_comment create
-- cattle.log comments bypassing tag parsing/issue state).

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

  RETURN public._activity_can_read(p_entity_type, p_entity_id);
END
$can_write$;

REVOKE ALL ON FUNCTION public._activity_can_write(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._activity_can_write(text, text) TO authenticated;

-- ── 15. Reload PostgREST schema cache ───────────────────────────────────────

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- End of 112_cattle_log.sql
-- ============================================================================
