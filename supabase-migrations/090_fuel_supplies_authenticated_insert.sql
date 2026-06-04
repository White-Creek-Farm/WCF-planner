-- ============================================================================
-- 090_fuel_supplies_authenticated_insert.sql
-- ----------------------------------------------------------------------------
-- Lane 1 CP1/CP2 fix: fuel_supplies authenticated INSERT policy.
--
-- CP1 made the report/form surfaces login-required. fuel_supplies (RLS on) had
-- only an anon INSERT policy (fuel_supplies_public_insert TO anon) plus
-- authenticated SELECT/UPDATE/DELETE — but NO authenticated INSERT policy. So
-- a logged-in user submitting the Fuel Supply form via the direct
-- useOfflineSubmit insert path was denied (RLS 42501). The daily tables are
-- RLS-disabled (authed insert ok) and Add Feed / equipment fueling / tasks go
-- through SECURITY DEFINER RPCs, so fuel_supplies was the only broken authed
-- create path.
--
-- This adds an authenticated INSERT policy (WITH CHECK true). The owner column
-- is stamped server-side by the mig 089 BEFORE INSERT trigger, so no row-level
-- ownership check is needed at insert time. The legacy anon INSERT policy is
-- left in place (harmless; the form no longer uses it). Idempotent.
-- ============================================================================

DROP POLICY IF EXISTS fuel_supplies_auth_insert ON public.fuel_supplies;
CREATE POLICY fuel_supplies_auth_insert ON public.fuel_supplies
  FOR INSERT TO authenticated WITH CHECK (true);
