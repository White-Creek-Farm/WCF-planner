-- ============================================================================
-- Migration 073: comment-photos Storage RLS policies
-- ----------------------------------------------------------------------------
-- PROD hotfix: authenticated users cannot upload comment photo attachments
-- because the comment-photos bucket (created via Dashboard in the migration
-- 071 era) has no INSERT or SELECT policies on storage.objects.
--
-- Error observed on PROD: "new row violates row-level security policy"
-- when CommentsSection tries to upload an attachment via
-- sb.storage.from('comment-photos').upload(...).
--
-- Adds two policies, matching the daily-photos pattern (migration 031):
--   1. Authenticated INSERT — lets any logged-in user upload photos.
--   2. Authenticated SELECT — lets admin/management views fetch signed URLs.
--
-- No anon INSERT: comment attachments are only posted from authenticated
-- record pages (CommentsSection). Public webforms do not post comments.
--
-- No anon SELECT: comment photos are private; reads go through signed URLs
-- generated from an authenticated session.
--
-- Idempotent: each policy is wrapped in a DO block that checks pg_policies
-- first (Postgres does not support CREATE POLICY IF NOT EXISTS).
-- ============================================================================

-- Ensure the bucket exists (idempotent). It should already exist from
-- Dashboard creation during the migration 071 era, but this guarantees
-- the migration is self-contained if replayed on a fresh environment.
INSERT INTO storage.buckets (id, name, public)
VALUES ('comment-photos', 'comment-photos', false)
ON CONFLICT (id) DO NOTHING;

-- (1) Authenticated INSERT into comment-photos
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'comment_photos_auth_insert'
  ) THEN
    CREATE POLICY comment_photos_auth_insert ON storage.objects
      FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'comment-photos');
  END IF;
END $$;

-- (2) Authenticated SELECT on comment-photos
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'comment_photos_auth_select'
  ) THEN
    CREATE POLICY comment_photos_auth_select ON storage.objects
      FOR SELECT TO authenticated
      USING (bucket_id = 'comment-photos');
  END IF;
END $$;
