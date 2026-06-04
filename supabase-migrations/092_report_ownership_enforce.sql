-- ============================================================================
-- 092_report_ownership_enforce.sql  —  Lane 1 CP2 STEP 4 of 4 (RED-SWITCH)
-- ----------------------------------------------------------------------------
-- Makes the ownership RPCs the ONLY write path that bypasses ownership, and
-- blocks direct PostgREST update/delete that would let a Light user edit rows
-- it does not own. APPLY LAST — only after every client edit path is converted
-- to the RPCs (mig 091) and the static guard confirms zero remaining direct
-- update/delete on the protected daily tables. TEST only until Ronnie approves
-- PROD.
--
-- Daily tables (RLS-disabled, default grants): REVOKE direct UPDATE/DELETE from
-- anon + authenticated. SELECT + INSERT grants stay (reads/lists + the
-- login-required create path keep working). All edits/deletes now go through
-- update_daily_report / soft_delete_daily_report (SECDEF, bypass the missing
-- grant, enforce ownership).
--
-- equipment_fuelings + fuel_supplies (RLS-enabled): tighten so direct
-- UPDATE/DELETE is allowed for PRIVILEGED roles only (the /fleet +
-- admin-fuel-log UIs keep working untouched) and DENIED for Light, forcing
-- Light through update_equipment_fueling / delete_equipment_fueling /
-- update_fuel_supply / delete_fuel_supply (ownership-checked). An owner-freeze
-- trigger prevents owner_profile_id from changing on any update.
--
-- Rollback is one-line: re-GRANT the daily privileges / re-add the blanket
-- policies.
-- ============================================================================

-- ── Daily tables: revoke direct update/delete (force the RPCs) ──────────────
REVOKE UPDATE, DELETE ON public.poultry_dailys FROM anon, authenticated;
REVOKE UPDATE, DELETE ON public.layer_dailys   FROM anon, authenticated;
REVOKE UPDATE, DELETE ON public.egg_dailys     FROM anon, authenticated;
REVOKE UPDATE, DELETE ON public.pig_dailys     FROM anon, authenticated;
REVOKE UPDATE, DELETE ON public.cattle_dailys  FROM anon, authenticated;
REVOKE UPDATE, DELETE ON public.sheep_dailys   FROM anon, authenticated;

-- ── Owner-freeze: owner_profile_id never changes on update ──────────────────
CREATE OR REPLACE FUNCTION public.freeze_owner_profile_id()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $fn$
BEGIN
  NEW.owner_profile_id := OLD.owner_profile_id;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_freeze_owner ON public.equipment_fuelings;
CREATE TRIGGER trg_freeze_owner BEFORE UPDATE ON public.equipment_fuelings
  FOR EACH ROW EXECUTE FUNCTION public.freeze_owner_profile_id();
DROP TRIGGER IF EXISTS trg_freeze_owner ON public.fuel_supplies;
CREATE TRIGGER trg_freeze_owner BEFORE UPDATE ON public.fuel_supplies
  FOR EACH ROW EXECUTE FUNCTION public.freeze_owner_profile_id();

-- ── equipment_fuelings: privileged-only direct update/delete; read-all ──────
DROP POLICY IF EXISTS equipment_fuelings_auth_all ON public.equipment_fuelings;
DROP POLICY IF EXISTS equipment_fuelings_auth_select ON public.equipment_fuelings;
CREATE POLICY equipment_fuelings_auth_select ON public.equipment_fuelings
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS equipment_fuelings_priv_update ON public.equipment_fuelings;
CREATE POLICY equipment_fuelings_priv_update ON public.equipment_fuelings
  FOR UPDATE TO authenticated
  USING (public.profile_role() = ANY (ARRAY['admin','management','farm_team','equipment_tech']))
  WITH CHECK (public.profile_role() = ANY (ARRAY['admin','management','farm_team','equipment_tech']));
DROP POLICY IF EXISTS equipment_fuelings_priv_delete ON public.equipment_fuelings;
CREATE POLICY equipment_fuelings_priv_delete ON public.equipment_fuelings
  FOR DELETE TO authenticated
  USING (public.profile_role() = ANY (ARRAY['admin','management','farm_team','equipment_tech']));

-- ── fuel_supplies: privileged-only direct update/delete; read-all + insert ──
DROP POLICY IF EXISTS fuel_supplies_auth_update ON public.fuel_supplies;
DROP POLICY IF EXISTS fuel_supplies_auth_delete ON public.fuel_supplies;
DROP POLICY IF EXISTS fuel_supplies_priv_update ON public.fuel_supplies;
CREATE POLICY fuel_supplies_priv_update ON public.fuel_supplies
  FOR UPDATE TO authenticated
  USING (public.profile_role() = ANY (ARRAY['admin','management','farm_team','equipment_tech']))
  WITH CHECK (public.profile_role() = ANY (ARRAY['admin','management','farm_team','equipment_tech']));
DROP POLICY IF EXISTS fuel_supplies_priv_delete ON public.fuel_supplies;
CREATE POLICY fuel_supplies_priv_delete ON public.fuel_supplies
  FOR DELETE TO authenticated
  USING (public.profile_role() = ANY (ARRAY['admin','management','farm_team','equipment_tech']));

NOTIFY pgrst, 'reload schema';
