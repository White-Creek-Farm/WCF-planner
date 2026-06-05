-- ============================================================================
-- 095_app_saved_views.sql
-- ----------------------------------------------------------------------------
-- Generic per-surface saved views ("Podio-style" saved filter/sort/view-mode
-- presets). First consumer: the cattle herds list (surface_key='cattle.herds').
--
-- Product contract (PROJECT.md Recommended Work Queue item 1):
--   * All authenticated users can save a list view as PRIVATE or PUBLIC.
--   * view_state holds {filters, sortRules, viewMode} (opaque jsonb here).
--   * PRIVATE views are owner-only. PUBLIC views are visible to every
--     authenticated user.
--   * Owners can update/delete their own views; nobody else can.
--
-- Ownership is SERVER-TRUSTED, never taken from the client (mirrors the mig 089
-- owner-stamp contract): a BEFORE INSERT trigger stamps owner_profile_id =
-- auth.uid(), overwriting any client-supplied value, and a BEFORE UPDATE
-- trigger freezes owner_profile_id and refreshes updated_at. Direct client
-- CRUD is acceptable here (saved views are user preferences, not audit-critical
-- entity writes) ONLY because RLS scopes every operation to public-or-owner
-- SELECT and owner-only INSERT/UPDATE/DELETE.
--
-- Additive + idempotent. Apply order: TEST first (via exec_sql — this file is
-- BEGIN/COMMIT-free so it also applies under psql --single-transaction for
-- PROD), PROD after lane + push approval so Netlify code never hits a missing
-- table.
-- ============================================================================

-- ── 1. Table ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.app_saved_views (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  surface_key       text NOT NULL,
  name              text NOT NULL,
  visibility        text NOT NULL DEFAULT 'private'
                      CHECK (visibility IN ('private', 'public')),
  view_state        jsonb NOT NULL DEFAULT '{}'::jsonb,
  owner_profile_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- public-or-owner SELECT lookups scan by surface + visibility; owner lookups by
-- owner_profile_id. Two partial-friendly btree indexes cover both.
CREATE INDEX IF NOT EXISTS app_saved_views_surface_idx
  ON public.app_saved_views (surface_key, visibility);
CREATE INDEX IF NOT EXISTS app_saved_views_owner_idx
  ON public.app_saved_views (owner_profile_id, surface_key);

-- ── 2. Server-trusted ownership + updated_at triggers ───────────────────────
-- INSERT: owner = auth.uid(), overwriting any client value. Anon/service_role
-- inserts (auth.uid() IS NULL) violate the NOT NULL column and fail loudly,
-- which is correct — only authenticated users own views.
CREATE OR REPLACE FUNCTION public.stamp_saved_view_owner()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
  NEW.owner_profile_id := auth.uid();
  NEW.created_at := COALESCE(NEW.created_at, now());
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;

-- UPDATE: freeze owner + created_at, refresh updated_at. Prevents an owner from
-- transferring a view to someone else and keeps the audit timestamps honest.
CREATE OR REPLACE FUNCTION public.touch_saved_view_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
  NEW.owner_profile_id := OLD.owner_profile_id;
  NEW.created_at := OLD.created_at;
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_stamp_saved_view_owner ON public.app_saved_views;
CREATE TRIGGER trg_stamp_saved_view_owner
  BEFORE INSERT ON public.app_saved_views
  FOR EACH ROW EXECUTE FUNCTION public.stamp_saved_view_owner();

DROP TRIGGER IF EXISTS trg_touch_saved_view_updated_at ON public.app_saved_views;
CREATE TRIGGER trg_touch_saved_view_updated_at
  BEFORE UPDATE ON public.app_saved_views
  FOR EACH ROW EXECUTE FUNCTION public.touch_saved_view_updated_at();

-- ── 3. Grants + RLS ─────────────────────────────────────────────────────────
REVOKE ALL ON TABLE public.app_saved_views FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.app_saved_views TO authenticated;

ALTER TABLE public.app_saved_views ENABLE ROW LEVEL SECURITY;

-- SELECT: a row is visible if it is public OR owned by the caller.
DROP POLICY IF EXISTS app_saved_views_select ON public.app_saved_views;
CREATE POLICY app_saved_views_select
  ON public.app_saved_views FOR SELECT
  TO authenticated
  USING (visibility = 'public' OR owner_profile_id = auth.uid());

-- INSERT: the resulting row (after the owner-stamp trigger) must belong to the
-- caller. The trigger sets owner = auth.uid() before this WITH CHECK runs, so a
-- client cannot insert a view owned by anyone else.
DROP POLICY IF EXISTS app_saved_views_insert ON public.app_saved_views;
CREATE POLICY app_saved_views_insert
  ON public.app_saved_views FOR INSERT
  TO authenticated
  WITH CHECK (owner_profile_id = auth.uid());

-- UPDATE: owner-only, and the row must still belong to the caller afterward
-- (the freeze trigger guarantees this; the WITH CHECK is belt-and-suspenders).
DROP POLICY IF EXISTS app_saved_views_update ON public.app_saved_views;
CREATE POLICY app_saved_views_update
  ON public.app_saved_views FOR UPDATE
  TO authenticated
  USING (owner_profile_id = auth.uid())
  WITH CHECK (owner_profile_id = auth.uid());

-- DELETE: owner-only.
DROP POLICY IF EXISTS app_saved_views_delete ON public.app_saved_views;
CREATE POLICY app_saved_views_delete
  ON public.app_saved_views FOR DELETE
  TO authenticated
  USING (owner_profile_id = auth.uid());

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- End of 095_app_saved_views.sql
-- ============================================================================
