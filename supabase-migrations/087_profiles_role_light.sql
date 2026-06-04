-- ============================================================================
-- 087_profiles_role_light.sql
-- ----------------------------------------------------------------------------
-- Add the authenticated 'light' role to the profiles.role CHECK constraint.
--
-- Lane 1 CP1 (authenticated Light-user portal) introduces a real, persisted
-- 'light' role: authenticated field users who are contained to the daily
-- report / Add Feed / Equipment fueling-checklist / Tasks form surfaces and
-- nothing else. The role is enforced in the app shell (nav + fail-closed route
-- containment) and is the foundation for the later ownership/RLS checkpoint
-- that will scope read/write by row owner.
--
-- The profiles.role CHECK constraint was last (re)created in mig 016 with the
-- five values farm_team / management / admin / inactive / equipment_tech. This
-- migration recreates it to add 'light'. The constraint name varies by
-- environment, so we drop IF EXISTS inside a guarded block (mirrors 016).
--
-- No data changes: no existing profile rows are touched. Existing rows already
-- satisfy the new constraint (it is a strict superset of the old value set).
-- Idempotent: re-running drops and re-adds the same constraint.
-- ============================================================================

DO $$
BEGIN
  -- The CHECK constraint name varies by environment; catch either.
  BEGIN
    ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
  EXCEPTION WHEN undefined_object THEN NULL;
  END;
END$$;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('farm_team','management','admin','inactive','equipment_tech','light'));
