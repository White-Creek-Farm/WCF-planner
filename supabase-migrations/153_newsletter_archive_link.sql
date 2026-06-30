-- 153_newsletter_archive_link.sql
-- ============================================================================
-- Gate the PUBLIC newsletter archive behind a rotating, expiring access key.
-- ----------------------------------------------------------------------------
-- Product change (Ronnie, 2026-06-30): the newsletter is no longer a fully
-- public no-login archive. Reading the published list or any published issue now
-- requires a CURRENT, UNEXPIRED archive access key (one shared key for the whole
-- archive — the new issue + all past issues). The goal: former staff can never
-- keep a working link. Their link expires (7 days), they never receive the next
-- month's link, and an admin "Regenerate" instantly kills the old link.
--
--   * publish_newsletter_issue mints a fresh key with a 7-day expiry, so the
--     published issue + archive are reachable for one week via the new link,
--     then lock until the next publish (or an admin regenerate).
--   * regenerate_newsletter_archive_link (admin) mints a fresh key on demand
--     (instant revoke + re-share; configurable window, default 7 days).
--   * The draft preview token (mig 144) is UNCHANGED — it is a separate path.
--   * Admins always read every issue via the authed admin RPCs regardless of the
--     public key state.
--
-- Boundary: tables stay deny-all RLS; the anon surface stays exactly three RPCs
-- (list_published_newsletters, get_published_newsletter, get_newsletter_preview)
-- — now key-gated for the first two. No raw operational tables, no
-- source_private_path, drafts/facts/intake/runs/settings stay admin-only.
--
-- Apply: TEST via exec_sql (whole body); PROD via psql --single-transaction
-- (ON_ERROR_STOP=1). No explicit BEGIN/COMMIT here — exec_sql rejects them and
-- psql --single-transaction already wraps the file in one transaction.
-- ============================================================================

-- ── 1. Singleton archive key + expiry on newsletter_settings ────────────────
ALTER TABLE public.newsletter_settings
  ADD COLUMN IF NOT EXISTS archive_access_token text,
  ADD COLUMN IF NOT EXISTS archive_access_expires_at timestamptz;

-- ── 2. Internal helper: is the presented key the current, unexpired one? ─────
-- SECURITY DEFINER + revoked from everyone: only the SECDEF anon RPCs below call
-- it (they run as the owner, which owns this function). Constant-time compare to
-- avoid token-length / early-exit timing leaks (mirrors get_newsletter_preview).
CREATE OR REPLACE FUNCTION public._newsletter_archive_key_ok(p_key text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $fn$
DECLARE
  v_token   text;
  v_expires timestamptz;
BEGIN
  IF p_key IS NULL OR btrim(p_key) = '' THEN
    RETURN false;
  END IF;
  SELECT archive_access_token, archive_access_expires_at
    INTO v_token, v_expires
    FROM public.newsletter_settings
    WHERE id = 'singleton';
  -- No key set, or no/past expiry -> locked.
  IF v_token IS NULL OR v_expires IS NULL OR now() > v_expires THEN
    RETURN false;
  END IF;
  RETURN length(v_token) = length(p_key)
     AND extensions.hmac(v_token, 'nl', 'sha256') = extensions.hmac(p_key, 'nl', 'sha256');
END
$fn$;

REVOKE ALL ON FUNCTION public._newsletter_archive_key_ok(text) FROM PUBLIC, anon, authenticated;

-- ── 3. Key-gate the two published-archive anon RPCs ─────────────────────────
-- Signatures change (gain p_key), so drop the old ones first to avoid PostgREST
-- overload ambiguity. Both return NULL when the key is missing/invalid/expired,
-- which the public app renders as the "link expired" lock screen.
DROP FUNCTION IF EXISTS public.list_published_newsletters();
CREATE OR REPLACE FUNCTION public.list_published_newsletters(p_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $fn$
DECLARE
  v jsonb;
BEGIN
  IF NOT public._newsletter_archive_key_ok(p_key) THEN
    RETURN NULL; -- locked: no valid current link
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'slug', i.slug,
    'yearMonth', i.year_month,
    'title', i.title,
    'publishedAt', i.published_at,
    'noindex', i.noindex,
    'cover', (
      SELECT jsonb_build_object('storagePath', p.storage_path, 'altText', p.alt_text, 'caption', p.caption)
      FROM public.newsletter_photos p
      WHERE p.issue_id = i.id AND p.approved AND p.is_cover
      LIMIT 1
    )
  ) ORDER BY i.published_at DESC), '[]'::jsonb)
  INTO v
  FROM public.newsletter_issues i
  WHERE i.status = 'published';

  RETURN v;
END
$fn$;

REVOKE ALL ON FUNCTION public.list_published_newsletters(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_published_newsletters(text) TO anon, authenticated;

DROP FUNCTION IF EXISTS public.get_published_newsletter(text);
CREATE OR REPLACE FUNCTION public.get_published_newsletter(p_slug text, p_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $fn$
DECLARE
  v_id text;
BEGIN
  IF NOT public._newsletter_archive_key_ok(p_key) THEN
    RETURN NULL; -- locked
  END IF;

  SELECT id INTO v_id
    FROM public.newsletter_issues
    WHERE slug = p_slug AND status = 'published'
    LIMIT 1;

  IF v_id IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN public._newsletter_render_payload(v_id, 'published');
END
$fn$;

REVOKE ALL ON FUNCTION public.get_published_newsletter(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_published_newsletter(text, text) TO anon, authenticated;

-- ── 4. Mint a fresh 7-day key on publish ────────────────────────────────────
-- Re-defines mig 144 publish_newsletter_issue: same body, plus it rotates the
-- singleton archive key (new random token, expiry now()+7 days) so the freshly
-- published issue is shareable for a week and the previous link dies at once.
CREATE OR REPLACE FUNCTION public.publish_newsletter_issue(p_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_status       text;
  v_published_at timestamptz;
  v_draft        jsonb;
BEGIN
  PERFORM public._newsletter_assert_admin();

  SELECT status, published_at, draft_payload
    INTO v_status, v_published_at, v_draft
    FROM public.newsletter_issues WHERE id = p_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NEWSLETTER_VALIDATION: issue not found';
  END IF;
  IF v_draft IS NULL OR jsonb_typeof(v_draft) <> 'object'
     OR NOT (v_draft ? 'blocks') THEN
    RAISE EXCEPTION 'NEWSLETTER_VALIDATION: draft has no content blocks to publish';
  END IF;

  UPDATE public.newsletter_issues
     SET status                   = 'published',
         published_payload        = v_draft,
         published_at             = COALESCE(v_published_at, now()),
         updated_after_publish_at = CASE WHEN v_published_at IS NOT NULL THEN now() ELSE updated_after_publish_at END,
         preview_token            = encode(extensions.gen_random_bytes(16), 'hex'),
         preview_enabled          = false,
         preview_expires_at       = NULL,
         updated_by               = auth.uid(),
         updated_at               = now()
   WHERE id = p_id;

  -- Rotate the public archive access link: a new 7-day key unlocks the archive
  -- (new + past issues); the prior link is dead immediately.
  UPDATE public.newsletter_settings
     SET archive_access_token      = encode(extensions.gen_random_bytes(16), 'hex'),
         archive_access_expires_at = now() + interval '7 days',
         updated_by                = auth.uid(),
         updated_at                = now()
   WHERE id = 'singleton';

  RETURN public._newsletter_issue_summary(p_id);
END
$fn$;

REVOKE ALL ON FUNCTION public.publish_newsletter_issue(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.publish_newsletter_issue(text) TO authenticated;

-- ── 5. Admin: regenerate the archive link on demand (instant revoke) ────────
CREATE OR REPLACE FUNCTION public.regenerate_newsletter_archive_link(p_days int DEFAULT 7)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_days int := LEAST(GREATEST(COALESCE(p_days, 7), 1), 60);
BEGIN
  PERFORM public._newsletter_assert_admin();
  UPDATE public.newsletter_settings
     SET archive_access_token      = encode(extensions.gen_random_bytes(16), 'hex'),
         archive_access_expires_at = now() + make_interval(days => v_days),
         updated_by                = auth.uid(),
         updated_at                = now()
   WHERE id = 'singleton';
  RETURN public.get_newsletter_settings();
END
$fn$;

REVOKE ALL ON FUNCTION public.regenerate_newsletter_archive_link(int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.regenerate_newsletter_archive_link(int) TO authenticated;

-- ── 6. Surface the current key + expiry to the admin settings read ──────────
-- Re-defines the mig 151 get_newsletter_settings with two added fields so the
-- admin UI can show + copy the live link and its expiry. Admin-only (unchanged).
CREATE OR REPLACE FUNCTION public.get_newsletter_settings()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v jsonb;
BEGIN
  PERFORM public._newsletter_assert_admin();
  SELECT jsonb_build_object(
    'aiProvider', s.ai_provider,
    'aiModel', s.ai_model,
    'tone', s.tone,
    'tonePreset', s.tone_preset,
    'lengthDetail', s.length_detail,
    'photoMin', s.photo_min,
    'photoTarget', s.photo_target,
    'pastIssueContextCount', s.past_issue_context_count,
    'taskAssigneeProfileId', s.task_assignee_profile_id,
    'draftGenDay', s.draft_gen_day,
    'publishTargetDay', s.publish_target_day,
    'archiveAccessToken', s.archive_access_token,
    'archiveAccessExpiresAt', s.archive_access_expires_at,
    'updatedAt', s.updated_at
  ) INTO v FROM public.newsletter_settings s WHERE s.id = 'singleton';
  RETURN COALESCE(v, '{}'::jsonb);
END
$fn$;

REVOKE ALL ON FUNCTION public.get_newsletter_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_newsletter_settings() TO authenticated;

NOTIFY pgrst, 'reload schema';
