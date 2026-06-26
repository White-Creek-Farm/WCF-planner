-- ============================================================================
-- 144_newsletter_engine.sql
-- ----------------------------------------------------------------------------
-- Newsletter Engine — data model + access boundary.
--
-- A monthly, web-only "White Creek Farm <Month> Review" newsletter. The engine
-- harvests noteworthy facts (each with evidence), drafts AI copy from approved
-- facts only, collects photos into a PUBLIC bucket, and publishes a sanitized,
-- structured payload to a no-login, noindex public archive.
--
-- This migration owns ONLY the data model and the access boundary:
--   1. Tables: newsletter_issues, newsletter_fact_candidates, newsletter_photos,
--      newsletter_runs, newsletter_settings. Deny-all RLS (mig 071/112/115
--      pattern): REVOKE ALL + ENABLE RLS + FOR ALL USING (false). Access only
--      through SECURITY DEFINER RPCs.
--   2. One-cover-per-issue and max-12-photos-per-issue DB backstops.
--   3. Internal SECDEF helpers (_newsletter_assert_admin, _newsletter_*_summary).
--   4. Admin-only RPCs (role='admin'): list/get/create/save/intake/fact-toggle/
--      manual-fact/photo register-update-remove-cover-approve/publish/unpublish.
--   5. Narrow ANON public read surface: list_published_newsletters,
--      get_published_newsletter(slug), get_newsletter_preview(slug, token).
--      These are the ONLY anon-reachable RPCs; they return sanitized
--      published/preview payloads and approved photo paths only. No anon access
--      to drafts, fact candidates, intake, settings, runs, or raw operational
--      tables.
--
-- The Edge Function generator/ingest RPCs and the monthly pg_cron schedule live
-- in the automation migration (146), so this file has no infra/cron coupling.
-- The newsletter-public storage bucket + policies live in migration 145.
--
-- Superlative honesty: every fact candidate carries comparison + confidence +
-- evidence_payload; record claims must state their evidence window. The DB does
-- not compute superlatives — it stores the harvested evidence so the admin can
-- inspect it before keeping a story.
--
-- Structured content only: draft_payload / published_payload are structured
-- block jsonb. The public renderer renders KNOWN block types — never raw AI
-- HTML. The DB stores the structure; the renderer enforces the whitelist.
--
-- Error class: deterministic failures use the 'NEWSLETTER_VALIDATION:' prefix.
-- The bare 'authenticated caller required' message stays UNprefixed (mig 112
-- convention).
--
-- NO BEGIN/COMMIT in this file: TEST applies via exec_sql (rejects them);
-- PROD applies with psql --single-transaction for atomicity.
-- Apply order: TEST first, PROD after lane approval.
-- Depends on: mig 058 (public.profile_role()), profiles. pgcrypto for tokens.
-- ============================================================================

-- pgcrypto (gen_random_bytes for tokens/ids, hmac for the preview-token compare)
-- lives in the Supabase `extensions` schema; the SECDEF RPCs run with
-- search_path=public, so every pgcrypto call below is schema-qualified
-- `extensions.<fn>` (same convention as mig 116's `extensions.ST_*`). gen_random_uuid
-- is a pg_catalog built-in and needs no qualification.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ── 1. newsletter_issues ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.newsletter_issues (
  id                       text PRIMARY KEY,
  year_month               text NOT NULL UNIQUE
                             CHECK (year_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  slug                     text NOT NULL UNIQUE,
  title                    text NOT NULL,
  status                   text NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft', 'published')),
  period_start             date NOT NULL,
  period_end               date NOT NULL,
  noindex                  boolean NOT NULL DEFAULT true,
  preview_token            text NOT NULL,
  preview_enabled          boolean NOT NULL DEFAULT true,
  preview_expires_at       timestamptz,
  draft_payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_payload        jsonb,
  intake_answers           jsonb NOT NULL DEFAULT '{}'::jsonb,
  generated_at             timestamptz,
  published_at             timestamptz,
  updated_after_publish_at timestamptz,
  created_by               uuid REFERENCES public.profiles(id),
  updated_by               uuid REFERENCES public.profiles(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- Public archive read path: newest published first.
CREATE INDEX IF NOT EXISTS newsletter_issues_published_idx
  ON public.newsletter_issues (published_at DESC)
  WHERE status = 'published';

REVOKE ALL ON TABLE public.newsletter_issues FROM PUBLIC, anon, authenticated;
ALTER TABLE public.newsletter_issues ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS newsletter_issues_deny_all ON public.newsletter_issues;
CREATE POLICY newsletter_issues_deny_all ON public.newsletter_issues
  FOR ALL USING (false);

-- ── 2. newsletter_fact_candidates ───────────────────────────────────────────
-- One harvested (or manual-intake) story candidate. Carries evidence so the
-- admin can inspect the raw numbers behind a claim before keeping it.

CREATE TABLE IF NOT EXISTS public.newsletter_fact_candidates (
  id               text PRIMARY KEY,
  issue_id         text NOT NULL
                     REFERENCES public.newsletter_issues(id) ON DELETE CASCADE,
  detector_key     text NOT NULL,
  program          text,
  title            text NOT NULL,
  summary          text,
  metric_value     numeric,
  display_value    text,
  source_refs      jsonb NOT NULL DEFAULT '[]'::jsonb,
  comparison       jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence       text NOT NULL DEFAULT 'medium'
                     CHECK (confidence IN ('high', 'medium', 'low')),
  included         boolean NOT NULL DEFAULT true,
  is_manual        boolean NOT NULL DEFAULT false,
  evidence_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort_order       int NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issue_id, detector_key)
);

CREATE INDEX IF NOT EXISTS newsletter_fact_candidates_issue_idx
  ON public.newsletter_fact_candidates (issue_id, sort_order, created_at);

REVOKE ALL ON TABLE public.newsletter_fact_candidates
  FROM PUBLIC, anon, authenticated;
ALTER TABLE public.newsletter_fact_candidates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS newsletter_fact_candidates_deny_all
  ON public.newsletter_fact_candidates;
CREATE POLICY newsletter_fact_candidates_deny_all
  ON public.newsletter_fact_candidates
  FOR ALL USING (false);

-- ── 3. newsletter_photos ────────────────────────────────────────────────────
-- Photos live in the PUBLIC newsletter-public bucket (mig 145). source_private_
-- path records that an image was copied (bytes re-uploaded) from a private
-- planner bucket after admin approval; private signed URLs are NEVER hotlinked.

CREATE TABLE IF NOT EXISTS public.newsletter_photos (
  id                  text PRIMARY KEY,
  issue_id            text NOT NULL
                        REFERENCES public.newsletter_issues(id) ON DELETE CASCADE,
  storage_path        text NOT NULL,
  source_private_path text,
  caption             text,
  alt_text            text,
  credit_first_name   text,
  is_cover            boolean NOT NULL DEFAULT false,
  sort_order          int NOT NULL DEFAULT 0,
  approved            boolean NOT NULL DEFAULT false,
  uploaded_by         uuid REFERENCES public.profiles(id),
  uploaded_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issue_id, storage_path)
);

CREATE INDEX IF NOT EXISTS newsletter_photos_issue_idx
  ON public.newsletter_photos (issue_id, sort_order, uploaded_at);

-- At most one cover photo per issue.
CREATE UNIQUE INDEX IF NOT EXISTS newsletter_photos_one_cover_idx
  ON public.newsletter_photos (issue_id)
  WHERE is_cover;

REVOKE ALL ON TABLE public.newsletter_photos FROM PUBLIC, anon, authenticated;
ALTER TABLE public.newsletter_photos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS newsletter_photos_deny_all ON public.newsletter_photos;
CREATE POLICY newsletter_photos_deny_all ON public.newsletter_photos
  FOR ALL USING (false);

-- Max 12 photos per issue (mig 114 advisory-lock-serialized backstop).
CREATE OR REPLACE FUNCTION public._enforce_newsletter_photos_max_12()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_count int;
BEGIN
  IF NEW.issue_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('newsletter_photos'), hashtext(NEW.issue_id));

  -- A same-issue update cannot increase the total row count.
  IF TG_OP = 'UPDATE' AND OLD.issue_id = NEW.issue_id THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_count
    FROM public.newsletter_photos
    WHERE issue_id = NEW.issue_id;

  IF v_count >= 12 THEN
    RAISE EXCEPTION 'NEWSLETTER_VALIDATION: max 12 photos per issue';
  END IF;

  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public._enforce_newsletter_photos_max_12()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS newsletter_photos_max_12 ON public.newsletter_photos;
CREATE TRIGGER newsletter_photos_max_12
  BEFORE INSERT OR UPDATE ON public.newsletter_photos
  FOR EACH ROW EXECUTE FUNCTION public._enforce_newsletter_photos_max_12();

-- ── 4. newsletter_runs (generation/AI/task audit) ───────────────────────────

CREATE TABLE IF NOT EXISTS public.newsletter_runs (
  id         text PRIMARY KEY,
  issue_id   text REFERENCES public.newsletter_issues(id) ON DELETE CASCADE,
  run_type   text NOT NULL
               CHECK (run_type IN ('harvest', 'ai_draft', 'task_create', 'publish')),
  provider   text,
  model      text,
  input_hash text,
  status     text NOT NULL DEFAULT 'started'
               CHECK (status IN ('started', 'ok', 'error')),
  error      text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS newsletter_runs_issue_idx
  ON public.newsletter_runs (issue_id, created_at DESC);

REVOKE ALL ON TABLE public.newsletter_runs FROM PUBLIC, anon, authenticated;
ALTER TABLE public.newsletter_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS newsletter_runs_deny_all ON public.newsletter_runs;
CREATE POLICY newsletter_runs_deny_all ON public.newsletter_runs
  FOR ALL USING (false);

-- ── 5. newsletter_settings (singleton) ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.newsletter_settings (
  id                      text PRIMARY KEY DEFAULT 'singleton'
                            CHECK (id = 'singleton'),
  ai_provider             text NOT NULL DEFAULT 'anthropic',
  ai_model                text,
  tone                    text NOT NULL DEFAULT 'warm-but-credible owner-facing farm update',
  task_assignee_profile_id uuid REFERENCES public.profiles(id),
  draft_gen_day           int NOT NULL DEFAULT 1 CHECK (draft_gen_day BETWEEN 1 AND 28),
  publish_target_day      int NOT NULL DEFAULT 5 CHECK (publish_target_day BETWEEN 1 AND 28),
  updated_by              uuid REFERENCES public.profiles(id),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.newsletter_settings (id) VALUES ('singleton')
  ON CONFLICT (id) DO NOTHING;

REVOKE ALL ON TABLE public.newsletter_settings FROM PUBLIC, anon, authenticated;
ALTER TABLE public.newsletter_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS newsletter_settings_deny_all ON public.newsletter_settings;
CREATE POLICY newsletter_settings_deny_all ON public.newsletter_settings
  FOR ALL USING (false);

-- ── 6. Internal helpers ─────────────────────────────────────────────────────

-- Admin gate. Newsletter is admin-only for view, edit, publish, unpublish.
CREATE OR REPLACE FUNCTION public._newsletter_assert_admin()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_role text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'newsletter: authenticated caller required';
  END IF;
  v_role := public.profile_role();
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'NEWSLETTER_VALIDATION: admin role required';
  END IF;
END
$fn$;

REVOKE ALL ON FUNCTION public._newsletter_assert_admin()
  FROM PUBLIC, anon, authenticated;

-- Full admin view of one issue: issue + fact candidates + photos + intake.
CREATE OR REPLACE FUNCTION public._newsletter_issue_summary(p_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $fn$
DECLARE
  v jsonb;
BEGIN
  SELECT jsonb_build_object(
    'id', i.id,
    'yearMonth', i.year_month,
    'slug', i.slug,
    'title', i.title,
    'status', i.status,
    'periodStart', i.period_start,
    'periodEnd', i.period_end,
    'noindex', i.noindex,
    'previewToken', i.preview_token,
    'previewEnabled', i.preview_enabled,
    'previewExpiresAt', i.preview_expires_at,
    'draftPayload', i.draft_payload,
    'publishedPayload', i.published_payload,
    'intakeAnswers', i.intake_answers,
    'generatedAt', i.generated_at,
    'publishedAt', i.published_at,
    'updatedAfterPublishAt', i.updated_after_publish_at,
    'createdAt', i.created_at,
    'updatedAt', i.updated_at,
    'facts', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', f.id,
        'detectorKey', f.detector_key,
        'program', f.program,
        'title', f.title,
        'summary', f.summary,
        'metricValue', f.metric_value,
        'displayValue', f.display_value,
        'sourceRefs', f.source_refs,
        'comparison', f.comparison,
        'confidence', f.confidence,
        'included', f.included,
        'isManual', f.is_manual,
        'evidence', f.evidence_payload,
        'sortOrder', f.sort_order
      ) ORDER BY f.sort_order, f.created_at)
      FROM public.newsletter_fact_candidates f
      WHERE f.issue_id = i.id
    ), '[]'::jsonb),
    'photos', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', p.id,
        'storagePath', p.storage_path,
        'sourcePrivatePath', p.source_private_path,
        'caption', p.caption,
        'altText', p.alt_text,
        'creditFirstName', p.credit_first_name,
        'isCover', p.is_cover,
        'sortOrder', p.sort_order,
        'approved', p.approved
      ) ORDER BY p.sort_order, p.uploaded_at)
      FROM public.newsletter_photos p
      WHERE p.issue_id = i.id
    ), '[]'::jsonb)
  )
  INTO v
  FROM public.newsletter_issues i
  WHERE i.id = p_id;

  RETURN v;
END
$fn$;

REVOKE ALL ON FUNCTION public._newsletter_issue_summary(text)
  FROM PUBLIC, anon, authenticated;

-- Sanitized public/preview render payload. mode 'published' -> published_payload
-- + approved photos; mode 'preview' -> draft_payload + all photos. NEVER exposes
-- intake answers, fact candidates, runs, settings, or source_private_path.
CREATE OR REPLACE FUNCTION public._newsletter_render_payload(p_id text, p_mode text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $fn$
DECLARE
  v jsonb;
BEGIN
  SELECT jsonb_build_object(
    'id', i.id,
    'yearMonth', i.year_month,
    'slug', i.slug,
    'title', i.title,
    'periodStart', i.period_start,
    'periodEnd', i.period_end,
    'noindex', true,
    'status', i.status,
    'mode', p_mode,
    'publishedAt', i.published_at,
    'updatedAfterPublishAt', i.updated_after_publish_at,
    'payload', CASE WHEN p_mode = 'preview' THEN i.draft_payload ELSE i.published_payload END,
    'photos', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', p.id,
        'storagePath', p.storage_path,
        'caption', p.caption,
        'altText', p.alt_text,
        'creditFirstName', p.credit_first_name,
        'isCover', p.is_cover,
        'sortOrder', p.sort_order
      ) ORDER BY p.is_cover DESC, p.sort_order, p.uploaded_at)
      FROM public.newsletter_photos p
      WHERE p.issue_id = i.id
        AND p.approved
    ), '[]'::jsonb)
  )
  INTO v
  FROM public.newsletter_issues i
  WHERE i.id = p_id;

  RETURN v;
END
$fn$;

REVOKE ALL ON FUNCTION public._newsletter_render_payload(text, text)
  FROM PUBLIC, anon, authenticated;

-- ── 7. Admin RPCs ───────────────────────────────────────────────────────────

-- List all issues for the admin workspace (lightweight: no payload bodies).
CREATE OR REPLACE FUNCTION public.list_newsletter_issues_admin()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v jsonb;
BEGIN
  PERFORM public._newsletter_assert_admin();

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', i.id,
    'yearMonth', i.year_month,
    'slug', i.slug,
    'title', i.title,
    'status', i.status,
    'periodStart', i.period_start,
    'periodEnd', i.period_end,
    'generatedAt', i.generated_at,
    'publishedAt', i.published_at,
    'updatedAfterPublishAt', i.updated_after_publish_at,
    'factCount', (SELECT count(*) FROM public.newsletter_fact_candidates f WHERE f.issue_id = i.id),
    'includedFactCount', (SELECT count(*) FROM public.newsletter_fact_candidates f WHERE f.issue_id = i.id AND f.included),
    'photoCount', (SELECT count(*) FROM public.newsletter_photos p WHERE p.issue_id = i.id)
  ) ORDER BY i.year_month DESC), '[]'::jsonb)
  INTO v
  FROM public.newsletter_issues i;

  RETURN v;
END
$fn$;

REVOKE ALL ON FUNCTION public.list_newsletter_issues_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_newsletter_issues_admin() TO authenticated;

-- Full one-issue admin view (the one-pass editor data source).
CREATE OR REPLACE FUNCTION public.get_newsletter_issue_admin(p_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v jsonb;
BEGIN
  PERFORM public._newsletter_assert_admin();
  v := public._newsletter_issue_summary(p_id);
  IF v IS NULL THEN
    RAISE EXCEPTION 'NEWSLETTER_VALIDATION: issue not found';
  END IF;
  RETURN v;
END
$fn$;

REVOKE ALL ON FUNCTION public.get_newsletter_issue_admin(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_newsletter_issue_admin(text) TO authenticated;

-- Manually create an issue for a month (the Edge Function uses its own ingest
-- RPC in mig 146; this is the admin "new issue" path). One issue per month.
CREATE OR REPLACE FUNCTION public.create_newsletter_issue(
  p_year_month text,
  p_title      text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_start date;
  v_end   date;
  v_id    text;
  v_title text;
BEGIN
  PERFORM public._newsletter_assert_admin();

  IF p_year_month IS NULL OR p_year_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'NEWSLETTER_VALIDATION: year_month must be YYYY-MM (month 01-12)';
  END IF;

  v_start := to_date(p_year_month || '-01', 'YYYY-MM-DD');
  v_end   := (v_start + interval '1 month' - interval '1 day')::date;

  IF to_char(v_start, 'YYYY-MM') <> p_year_month THEN
    RAISE EXCEPTION 'NEWSLETTER_VALIDATION: invalid year_month %', p_year_month;
  END IF;

  v_id    := 'nli-' || p_year_month;
  v_title := COALESCE(NULLIF(btrim(p_title), ''),
                      'White Creek Farm ' || to_char(v_start, 'FMMonth YYYY') || ' Review');

  IF EXISTS (SELECT 1 FROM public.newsletter_issues WHERE id = v_id) THEN
    RAISE EXCEPTION 'NEWSLETTER_VALIDATION: issue for % already exists', p_year_month;
  END IF;

  INSERT INTO public.newsletter_issues (
    id, year_month, slug, title, status, period_start, period_end,
    noindex, preview_token, preview_expires_at, created_by, updated_by
  )
  VALUES (
    v_id, p_year_month, p_year_month, v_title, 'draft', v_start, v_end,
    true, encode(extensions.gen_random_bytes(16), 'hex'), now() + interval '30 days', auth.uid(), auth.uid()
  );

  RETURN public._newsletter_issue_summary(v_id);
END
$fn$;

REVOKE ALL ON FUNCTION public.create_newsletter_issue(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_newsletter_issue(text, text) TO authenticated;

-- Save the working draft payload (structured content blocks).
CREATE OR REPLACE FUNCTION public.save_newsletter_draft(
  p_id            text,
  p_draft_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  PERFORM public._newsletter_assert_admin();

  IF p_draft_payload IS NULL OR jsonb_typeof(p_draft_payload) <> 'object' THEN
    RAISE EXCEPTION 'NEWSLETTER_VALIDATION: draft payload must be a JSON object';
  END IF;

  UPDATE public.newsletter_issues
     SET draft_payload = p_draft_payload,
         updated_by    = auth.uid(),
         updated_at    = now()
   WHERE id = p_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NEWSLETTER_VALIDATION: issue not found';
  END IF;

  RETURN public._newsletter_issue_summary(p_id);
END
$fn$;

REVOKE ALL ON FUNCTION public.save_newsletter_draft(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_newsletter_draft(text, jsonb) TO authenticated;

-- Save the monthly intake checklist answers.
CREATE OR REPLACE FUNCTION public.save_newsletter_intake(
  p_id             text,
  p_intake_answers jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  PERFORM public._newsletter_assert_admin();

  IF p_intake_answers IS NULL OR jsonb_typeof(p_intake_answers) <> 'object' THEN
    RAISE EXCEPTION 'NEWSLETTER_VALIDATION: intake answers must be a JSON object';
  END IF;

  UPDATE public.newsletter_issues
     SET intake_answers = p_intake_answers,
         updated_by     = auth.uid(),
         updated_at     = now()
   WHERE id = p_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NEWSLETTER_VALIDATION: issue not found';
  END IF;

  RETURN public._newsletter_issue_summary(p_id);
END
$fn$;

REVOKE ALL ON FUNCTION public.save_newsletter_intake(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_newsletter_intake(text, jsonb) TO authenticated;

-- Toggle whether a fact candidate is included in the issue.
CREATE OR REPLACE FUNCTION public.set_newsletter_fact_included(
  p_fact_id  text,
  p_included boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_issue_id text;
BEGIN
  PERFORM public._newsletter_assert_admin();

  UPDATE public.newsletter_fact_candidates
     SET included = COALESCE(p_included, true)
   WHERE id = p_fact_id
  RETURNING issue_id INTO v_issue_id;

  IF v_issue_id IS NULL THEN
    RAISE EXCEPTION 'NEWSLETTER_VALIDATION: fact candidate not found';
  END IF;

  RETURN public._newsletter_issue_summary(v_issue_id);
END
$fn$;

REVOKE ALL ON FUNCTION public.set_newsletter_fact_included(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_newsletter_fact_included(text, boolean) TO authenticated;

-- Add a manual (intake-derived) fact candidate with admin-visible provenance.
CREATE OR REPLACE FUNCTION public.add_newsletter_manual_fact(
  p_issue_id text,
  p_title    text,
  p_summary  text DEFAULT NULL,
  p_program  text DEFAULT 'manual'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_id       text;
  v_next     int;
  v_detector text;
BEGIN
  PERFORM public._newsletter_assert_admin();

  IF NOT EXISTS (SELECT 1 FROM public.newsletter_issues WHERE id = p_issue_id) THEN
    RAISE EXCEPTION 'NEWSLETTER_VALIDATION: issue not found';
  END IF;
  IF p_title IS NULL OR btrim(p_title) = '' THEN
    RAISE EXCEPTION 'NEWSLETTER_VALIDATION: manual fact title required';
  END IF;

  v_id       := 'nlf-' || encode(extensions.gen_random_bytes(8), 'hex');
  v_detector := 'manual_' || encode(extensions.gen_random_bytes(4), 'hex');

  SELECT COALESCE(max(sort_order), 0) + 1 INTO v_next
    FROM public.newsletter_fact_candidates WHERE issue_id = p_issue_id;

  INSERT INTO public.newsletter_fact_candidates (
    id, issue_id, detector_key, program, title, summary,
    source_refs, comparison, confidence, included, is_manual,
    evidence_payload, sort_order
  )
  VALUES (
    v_id, p_issue_id, v_detector, COALESCE(NULLIF(btrim(p_program), ''), 'manual'),
    btrim(p_title), NULLIF(btrim(p_summary), ''),
    jsonb_build_array(jsonb_build_object('module', 'manual_intake')),
    '{}'::jsonb, 'high', true, true,
    jsonb_build_object('enteredBy', auth.uid(), 'enteredAt', now()), v_next
  );

  RETURN public._newsletter_issue_summary(p_issue_id);
END
$fn$;

REVOKE ALL ON FUNCTION public.add_newsletter_manual_fact(text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_newsletter_manual_fact(text, text, text, text) TO authenticated;

-- Register a photo whose bytes already live in the newsletter-public bucket.
-- source_private_path records a copy-from-private provenance (bytes were
-- re-uploaded, never a hotlinked signed URL).
CREATE OR REPLACE FUNCTION public.register_newsletter_photo(
  p_issue_id            text,
  p_storage_path        text,
  p_source_private_path text DEFAULT NULL,
  p_caption             text DEFAULT NULL,
  p_alt_text            text DEFAULT NULL,
  p_first_name          text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_id     text;
  v_prefix text;
  v_next   int;
BEGIN
  PERFORM public._newsletter_assert_admin();

  IF NOT EXISTS (SELECT 1 FROM public.newsletter_issues WHERE id = p_issue_id) THEN
    RAISE EXCEPTION 'NEWSLETTER_VALIDATION: issue not found';
  END IF;
  IF p_storage_path IS NULL OR btrim(p_storage_path) = '' THEN
    RAISE EXCEPTION 'NEWSLETTER_VALIDATION: storage path required';
  END IF;

  -- Path must live under this issue's prefix and carry no traversal segments.
  v_prefix := 'newsletter/' || p_issue_id || '/';
  IF left(p_storage_path, length(v_prefix)) <> v_prefix
     OR position('..' IN p_storage_path) > 0 THEN
    RAISE EXCEPTION 'NEWSLETTER_VALIDATION: storage path must be under %', v_prefix;
  END IF;

  v_id := 'nlp-' || encode(extensions.gen_random_bytes(8), 'hex');

  SELECT COALESCE(max(sort_order), 0) + 1 INTO v_next
    FROM public.newsletter_photos WHERE issue_id = p_issue_id;

  INSERT INTO public.newsletter_photos (
    id, issue_id, storage_path, source_private_path,
    caption, alt_text, credit_first_name, sort_order, approved, uploaded_by
  )
  VALUES (
    v_id, p_issue_id, btrim(p_storage_path), NULLIF(btrim(p_source_private_path), ''),
    NULLIF(btrim(p_caption), ''), NULLIF(btrim(p_alt_text), ''),
    NULLIF(btrim(p_first_name), ''), v_next, false, auth.uid()
  );

  RETURN public._newsletter_issue_summary(p_issue_id);
END
$fn$;

REVOKE ALL ON FUNCTION public.register_newsletter_photo(text, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_newsletter_photo(text, text, text, text, text, text) TO authenticated;

-- Edit a photo's caption/alt/credit/order/approval.
CREATE OR REPLACE FUNCTION public.update_newsletter_photo(
  p_id         text,
  p_caption    text DEFAULT NULL,
  p_alt_text   text DEFAULT NULL,
  p_first_name text DEFAULT NULL,
  p_sort_order int  DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_issue_id text;
BEGIN
  PERFORM public._newsletter_assert_admin();

  UPDATE public.newsletter_photos
     SET caption           = NULLIF(btrim(COALESCE(p_caption, caption)), ''),
         alt_text          = NULLIF(btrim(COALESCE(p_alt_text, alt_text)), ''),
         credit_first_name = NULLIF(btrim(COALESCE(p_first_name, credit_first_name)), ''),
         sort_order        = COALESCE(p_sort_order, sort_order)
   WHERE id = p_id
  RETURNING issue_id INTO v_issue_id;

  IF v_issue_id IS NULL THEN
    RAISE EXCEPTION 'NEWSLETTER_VALIDATION: photo not found';
  END IF;

  RETURN public._newsletter_issue_summary(v_issue_id);
END
$fn$;

REVOKE ALL ON FUNCTION public.update_newsletter_photo(text, text, text, text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_newsletter_photo(text, text, text, text, int) TO authenticated;

-- Approve / unapprove a photo. Approval is the consent-to-public gate: the
-- client copies the bytes from newsletter-staging (private) into
-- newsletter-public BEFORE approving, and deletes them from newsletter-public
-- AFTER unapproving. This RPC only flips the flag the public/preview RPCs read,
-- so unapproved bytes never become reachable by public URL.
CREATE OR REPLACE FUNCTION public.set_newsletter_photo_approved(
  p_id       text,
  p_approved boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_issue_id text;
BEGIN
  PERFORM public._newsletter_assert_admin();

  UPDATE public.newsletter_photos
     SET approved = COALESCE(p_approved, false)
   WHERE id = p_id
  RETURNING issue_id INTO v_issue_id;

  IF v_issue_id IS NULL THEN
    RAISE EXCEPTION 'NEWSLETTER_VALIDATION: photo not found';
  END IF;

  RETURN public._newsletter_issue_summary(v_issue_id);
END
$fn$;

REVOKE ALL ON FUNCTION public.set_newsletter_photo_approved(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_newsletter_photo_approved(text, boolean) TO authenticated;

-- Set one photo as the issue cover (clears any prior cover atomically).
CREATE OR REPLACE FUNCTION public.set_newsletter_cover(
  p_issue_id text,
  p_photo_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  PERFORM public._newsletter_assert_admin();

  IF NOT EXISTS (
    SELECT 1 FROM public.newsletter_photos
    WHERE id = p_photo_id AND issue_id = p_issue_id
  ) THEN
    RAISE EXCEPTION 'NEWSLETTER_VALIDATION: photo not found for issue';
  END IF;

  -- Clear first (so the one-cover partial unique index never conflicts), then set.
  UPDATE public.newsletter_photos
     SET is_cover = false
   WHERE issue_id = p_issue_id AND is_cover AND id <> p_photo_id;

  UPDATE public.newsletter_photos
     SET is_cover = true
   WHERE id = p_photo_id;

  RETURN public._newsletter_issue_summary(p_issue_id);
END
$fn$;

REVOKE ALL ON FUNCTION public.set_newsletter_cover(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_newsletter_cover(text, text) TO authenticated;

-- Remove a photo row. Storage-object cleanup is the client's responsibility
-- (delete from newsletter-public) before/after calling this.
CREATE OR REPLACE FUNCTION public.remove_newsletter_photo(p_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_issue_id text;
BEGIN
  PERFORM public._newsletter_assert_admin();

  DELETE FROM public.newsletter_photos
   WHERE id = p_id
  RETURNING issue_id INTO v_issue_id;

  IF v_issue_id IS NULL THEN
    RAISE EXCEPTION 'NEWSLETTER_VALIDATION: photo not found';
  END IF;

  RETURN public._newsletter_issue_summary(v_issue_id);
END
$fn$;

REVOKE ALL ON FUNCTION public.remove_newsletter_photo(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_newsletter_photo(text) TO authenticated;

-- Publish (or re-publish) an issue: snapshot draft_payload -> published_payload.
-- First publish stamps published_at; later publishes stamp updated_after_publish_at.
CREATE OR REPLACE FUNCTION public.publish_newsletter_issue(p_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_status      text;
  v_published_at timestamptz;
  v_draft       jsonb;
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

  -- Rotate + disable the preview token on publish so a shared pre-publish
  -- preview link cannot keep exposing later unpublished draft edits; the
  -- published page is the canonical surface from here.
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

  RETURN public._newsletter_issue_summary(p_id);
END
$fn$;

REVOKE ALL ON FUNCTION public.publish_newsletter_issue(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.publish_newsletter_issue(text) TO authenticated;

-- Pull an issue back to draft (removes it from the public archive immediately;
-- published_payload is retained for a later re-publish).
CREATE OR REPLACE FUNCTION public.unpublish_newsletter_issue(p_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  PERFORM public._newsletter_assert_admin();

  -- Rotate the preview token so any link shared while previously published is
  -- invalidated; re-enable preview for the new draft cycle with a fresh 30-day
  -- expiry window (preview is only valid while unexpired).
  UPDATE public.newsletter_issues
     SET status             = 'draft',
         preview_token      = encode(extensions.gen_random_bytes(16), 'hex'),
         preview_enabled    = true,
         preview_expires_at = now() + interval '30 days',
         updated_by         = auth.uid(),
         updated_at         = now()
   WHERE id = p_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NEWSLETTER_VALIDATION: issue not found';
  END IF;

  RETURN public._newsletter_issue_summary(p_id);
END
$fn$;

REVOKE ALL ON FUNCTION public.unpublish_newsletter_issue(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unpublish_newsletter_issue(text) TO authenticated;

-- Rotate the preview token on demand (invalidates previously shared preview
-- links) and re-enable preview with a fresh 30-day expiry window. Preview is a
-- DRAFT-only affordance: a published issue's canonical surface is its public
-- page, so regeneration is rejected for published issues (publish disabled the
-- token; the way to re-open preview is unpublish).
CREATE OR REPLACE FUNCTION public.regenerate_newsletter_preview_token(p_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_status text;
BEGIN
  PERFORM public._newsletter_assert_admin();

  SELECT status INTO v_status FROM public.newsletter_issues WHERE id = p_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'NEWSLETTER_VALIDATION: issue not found';
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'NEWSLETTER_VALIDATION: preview is only available for draft issues';
  END IF;

  UPDATE public.newsletter_issues
     SET preview_token    = encode(extensions.gen_random_bytes(16), 'hex'),
         preview_enabled  = true,
         preview_expires_at = now() + interval '30 days',
         updated_by       = auth.uid(),
         updated_at       = now()
   WHERE id = p_id;

  RETURN public._newsletter_issue_summary(p_id);
END
$fn$;

REVOKE ALL ON FUNCTION public.regenerate_newsletter_preview_token(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.regenerate_newsletter_preview_token(text) TO authenticated;

-- Admin settings read/update (provider/model/tone/assignee/cadence/noindex).
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
    'taskAssigneeProfileId', s.task_assignee_profile_id,
    'draftGenDay', s.draft_gen_day,
    'publishTargetDay', s.publish_target_day,
    'updatedAt', s.updated_at
  ) INTO v FROM public.newsletter_settings s WHERE s.id = 'singleton';
  RETURN COALESCE(v, '{}'::jsonb);
END
$fn$;

REVOKE ALL ON FUNCTION public.get_newsletter_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_newsletter_settings() TO authenticated;

CREATE OR REPLACE FUNCTION public.update_newsletter_settings(
  p_ai_provider         text DEFAULT NULL,
  p_ai_model            text DEFAULT NULL,
  p_tone                text DEFAULT NULL,
  p_task_assignee       uuid DEFAULT NULL,
  p_draft_gen_day       int  DEFAULT NULL,
  p_publish_target_day  int  DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  PERFORM public._newsletter_assert_admin();

  UPDATE public.newsletter_settings
     SET ai_provider              = COALESCE(NULLIF(btrim(p_ai_provider), ''), ai_provider),
         ai_model                 = COALESCE(NULLIF(btrim(p_ai_model), ''), ai_model),
         tone                     = COALESCE(NULLIF(btrim(p_tone), ''), tone),
         task_assignee_profile_id = COALESCE(p_task_assignee, task_assignee_profile_id),
         draft_gen_day            = COALESCE(p_draft_gen_day, draft_gen_day),
         publish_target_day       = COALESCE(p_publish_target_day, publish_target_day),
         updated_by               = auth.uid(),
         updated_at               = now()
   WHERE id = 'singleton';

  RETURN public.get_newsletter_settings();
END
$fn$;

REVOKE ALL ON FUNCTION public.update_newsletter_settings(text, text, text, uuid, int, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_newsletter_settings(text, text, text, uuid, int, int) TO authenticated;

-- ── 8. Public (anon) read surface — the ONLY anon-reachable newsletter RPCs ──
-- These return sanitized published/preview payloads + approved photo paths only.
-- No auth.uid() requirement; no access to drafts (except token preview), fact
-- candidates, intake, runs, settings, or raw operational tables.

CREATE OR REPLACE FUNCTION public.list_published_newsletters()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $fn$
DECLARE
  v jsonb;
BEGIN
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

REVOKE ALL ON FUNCTION public.list_published_newsletters() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_published_newsletters() TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_published_newsletter(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $fn$
DECLARE
  v_id text;
BEGIN
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

REVOKE ALL ON FUNCTION public.get_published_newsletter(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_published_newsletter(text) TO anon, authenticated;

-- Token-gated draft preview so an admin can share an exact public-page preview
-- before publishing. Constant-time token compare; works on draft issues only.
CREATE OR REPLACE FUNCTION public.get_newsletter_preview(p_slug text, p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $fn$
DECLARE
  v_id      text;
  v_token   text;
  v_enabled boolean;
  v_expires timestamptz;
BEGIN
  IF p_token IS NULL OR btrim(p_token) = '' THEN
    RETURN NULL;
  END IF;

  -- Preview is for DRAFT issues only (the published page is the canonical
  -- surface once published; publish disables the token). Selecting status='draft'
  -- here matches the product boundary even if preview_enabled ever drifted.
  SELECT id, preview_token, preview_enabled, preview_expires_at
    INTO v_id, v_token, v_enabled, v_expires
    FROM public.newsletter_issues
    WHERE slug = p_slug AND status = 'draft'
    LIMIT 1;

  -- Reject missing/non-draft issue, disabled preview, a NULL expiry, or an
  -- expired window before the token compare so a stale/disabled link reveals
  -- nothing. Expiry must be a real future timestamp — a NULL expiry never passes.
  IF v_id IS NULL OR v_token IS NULL OR NOT COALESCE(v_enabled, false)
     OR v_expires IS NULL OR now() > v_expires THEN
    RETURN NULL;
  END IF;

  -- Constant-time compare (avoid token-length/early-exit timing leaks).
  IF NOT (length(v_token) = length(p_token)
          AND extensions.hmac(v_token, 'nl', 'sha256') = extensions.hmac(p_token, 'nl', 'sha256')) THEN
    RETURN NULL;
  END IF;

  RETURN public._newsletter_render_payload(v_id, 'preview');
END
$fn$;

REVOKE ALL ON FUNCTION public.get_newsletter_preview(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_newsletter_preview(text, text) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
