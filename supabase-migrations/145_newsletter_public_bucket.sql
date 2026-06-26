-- ============================================================================
-- 145_newsletter_public_bucket.sql
-- ----------------------------------------------------------------------------
-- Storage for newsletter images: a PRIVATE staging bucket plus a PUBLIC
-- serving bucket.
--
-- Privacy model (closes the "unapproved bytes are public" hole): an admin never
-- uploads directly into a public bucket. All uploads and all copies of existing
-- private planner photos land first in the PRIVATE newsletter-staging bucket
-- (admin signed-URL read only). Only when the admin APPROVES a photo are its
-- bytes copied to the PUBLIC newsletter-public bucket at the SAME relative path
-- (mig 144 set_newsletter_photo_approved flips approved=true after the copy).
-- Unapproved or later-removed photos never become reachable by public URL, and
-- private signed URLs are NEVER hotlinked into a public page.
--
--   * newsletter-staging (PRIVATE) — admin-only INSERT/SELECT/UPDATE/DELETE.
--     Working area: new uploads + re-uploaded copies of private planner photos.
--   * newsletter-public (PUBLIC) — public/anon/auth SELECT; admin-only
--     INSERT/UPDATE/DELETE. Holds only approved (copied) bytes.
--
-- The other private planner buckets (daily-photos, task-photos,
-- task-request-photos, comment-photos, fuel-bills, equipment-maintenance-docs,
-- cattle-feed-pdfs, batch-documents) are unchanged.
--
-- Policies are bucket-scoped (cannot widen any other bucket) and DO-block
-- idempotent (Postgres has no CREATE POLICY IF NOT EXISTS). Admin role gate
-- mirrors mig 068's admin policy shape (EXISTS over public.profiles).
--
-- No BEGIN/COMMIT (TEST applies via exec_sql, which rejects them; PROD applies
-- with psql --single-transaction). Apply order: TEST first, PROD after approval.
-- GATE: this migration creates storage buckets; PROD apply needs explicit
-- Ronnie approval per HO (PROD Storage bucket create).
-- ============================================================================

-- (1) Buckets: private staging + public serving.
INSERT INTO storage.buckets (id, name, public)
VALUES ('newsletter-staging', 'newsletter-staging', false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public)
VALUES ('newsletter-public', 'newsletter-public', true)
ON CONFLICT (id) DO NOTHING;

-- ── newsletter-staging (PRIVATE): admin-only everything ─────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'newsletter_staging_admin_select'
  ) THEN
    CREATE POLICY newsletter_staging_admin_select ON storage.objects
      FOR SELECT TO authenticated
      USING (
        bucket_id = 'newsletter-staging'
        AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'newsletter_staging_admin_insert'
  ) THEN
    CREATE POLICY newsletter_staging_admin_insert ON storage.objects
      FOR INSERT TO authenticated
      WITH CHECK (
        bucket_id = 'newsletter-staging'
        AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'newsletter_staging_admin_update'
  ) THEN
    CREATE POLICY newsletter_staging_admin_update ON storage.objects
      FOR UPDATE TO authenticated
      USING (
        bucket_id = 'newsletter-staging'
        AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
      )
      WITH CHECK (
        bucket_id = 'newsletter-staging'
        AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'newsletter_staging_admin_delete'
  ) THEN
    CREATE POLICY newsletter_staging_admin_delete ON storage.objects
      FOR DELETE TO authenticated
      USING (
        bucket_id = 'newsletter-staging'
        AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
      );
  END IF;
END $$;

-- ── newsletter-public (PUBLIC read, admin-only write) ───────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'newsletter_public_read'
  ) THEN
    CREATE POLICY newsletter_public_read ON storage.objects
      FOR SELECT TO anon, authenticated
      USING (bucket_id = 'newsletter-public');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'newsletter_public_admin_insert'
  ) THEN
    CREATE POLICY newsletter_public_admin_insert ON storage.objects
      FOR INSERT TO authenticated
      WITH CHECK (
        bucket_id = 'newsletter-public'
        AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'newsletter_public_admin_update'
  ) THEN
    CREATE POLICY newsletter_public_admin_update ON storage.objects
      FOR UPDATE TO authenticated
      USING (
        bucket_id = 'newsletter-public'
        AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
      )
      WITH CHECK (
        bucket_id = 'newsletter-public'
        AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'newsletter_public_admin_delete'
  ) THEN
    CREATE POLICY newsletter_public_admin_delete ON storage.objects
      FOR DELETE TO authenticated
      USING (
        bucket_id = 'newsletter-public'
        AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
      );
  END IF;
END $$;
