-- ============================================================================
-- 089_report_owner_stamp_trigger.sql
-- ----------------------------------------------------------------------------
-- Lane 1 CP2 — STEP 2 of 4: server-trusted ownership stamping.
--
-- Codex amendment 1 (locked): ownership must be server-trusted, never taken
-- from the client. A BEFORE INSERT trigger stamps owner_profile_id =
-- auth.uid() on every report table, OVERWRITING any client-supplied value.
--
--   - Authenticated insert (direct PostgREST OR via a SECURITY DEFINER submit
--     RPC — auth.uid() reflects the original caller in both) -> owner = caller.
--   - Anon / service_role insert (auth.uid() IS NULL) -> owner NULL = unowned
--     = read-only for Light.
--   - Fires on INSERT only: owner_profile_id never changes on edit. The update
--     RPC (mig 090) must keep owner_profile_id out of its column allowlist.
--
-- Offline replay attribution: a queued insert replays as the then-logged-in
-- authenticated user, so the trigger stamps that user. A client-stored
-- profileId is never treated as proof of ownership.
--
-- Idempotent: CREATE OR REPLACE FUNCTION + DROP/CREATE TRIGGER per table.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.stamp_owner_profile_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
  -- Always the authenticated caller; overwrites any client-supplied value.
  NEW.owner_profile_id := auth.uid();
  RETURN NEW;
END;
$fn$;

-- BEFORE INSERT triggers on every report surface ----------------------------
DROP TRIGGER IF EXISTS trg_stamp_owner ON public.poultry_dailys;
CREATE TRIGGER trg_stamp_owner BEFORE INSERT ON public.poultry_dailys
  FOR EACH ROW EXECUTE FUNCTION public.stamp_owner_profile_id();

DROP TRIGGER IF EXISTS trg_stamp_owner ON public.layer_dailys;
CREATE TRIGGER trg_stamp_owner BEFORE INSERT ON public.layer_dailys
  FOR EACH ROW EXECUTE FUNCTION public.stamp_owner_profile_id();

DROP TRIGGER IF EXISTS trg_stamp_owner ON public.egg_dailys;
CREATE TRIGGER trg_stamp_owner BEFORE INSERT ON public.egg_dailys
  FOR EACH ROW EXECUTE FUNCTION public.stamp_owner_profile_id();

DROP TRIGGER IF EXISTS trg_stamp_owner ON public.pig_dailys;
CREATE TRIGGER trg_stamp_owner BEFORE INSERT ON public.pig_dailys
  FOR EACH ROW EXECUTE FUNCTION public.stamp_owner_profile_id();

DROP TRIGGER IF EXISTS trg_stamp_owner ON public.cattle_dailys;
CREATE TRIGGER trg_stamp_owner BEFORE INSERT ON public.cattle_dailys
  FOR EACH ROW EXECUTE FUNCTION public.stamp_owner_profile_id();

DROP TRIGGER IF EXISTS trg_stamp_owner ON public.sheep_dailys;
CREATE TRIGGER trg_stamp_owner BEFORE INSERT ON public.sheep_dailys
  FOR EACH ROW EXECUTE FUNCTION public.stamp_owner_profile_id();

DROP TRIGGER IF EXISTS trg_stamp_owner ON public.daily_submissions;
CREATE TRIGGER trg_stamp_owner BEFORE INSERT ON public.daily_submissions
  FOR EACH ROW EXECUTE FUNCTION public.stamp_owner_profile_id();

DROP TRIGGER IF EXISTS trg_stamp_owner ON public.equipment_fuelings;
CREATE TRIGGER trg_stamp_owner BEFORE INSERT ON public.equipment_fuelings
  FOR EACH ROW EXECUTE FUNCTION public.stamp_owner_profile_id();

DROP TRIGGER IF EXISTS trg_stamp_owner ON public.fuel_supplies;
CREATE TRIGGER trg_stamp_owner BEFORE INSERT ON public.fuel_supplies
  FOR EACH ROW EXECUTE FUNCTION public.stamp_owner_profile_id();
