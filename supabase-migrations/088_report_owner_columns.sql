-- ============================================================================
-- 088_report_owner_columns.sql
-- ----------------------------------------------------------------------------
-- Lane 1 CP2 (Light-user own-record edit/delete) — STEP 1 of 4: data model.
--
-- Adds a durable owner column, owner_profile_id, to every report surface a
-- Light user can submit, so the later ownership RPCs (mig 090) and the
-- enforcement switch (mig 091) can scope edit/delete to "your own records".
--
-- Tables:
--   poultry_dailys, layer_dailys, egg_dailys, pig_dailys, cattle_dailys,
--   sheep_dailys  (daily reports; Add Feed rows live here too via source=
--                  'add_feed_webform')
--   daily_submissions  (Add Feed parent)
--   equipment_fuelings, fuel_supplies
--
-- Semantics:
--   owner_profile_id = the AUTHENTICATED submitter (stamped server-side by the
--   BEFORE INSERT trigger added in mig 089 — never trusted from the client).
--   NULL = unowned = legacy / anonymous = read-only for Light, fully editable
--   by privileged roles. NO backfill: legacy rows stay NULL by design (the
--   free-text team_member name is NOT a reliable profile mapping).
--
-- Additive + idempotent. No behavior change on its own. Column type/FK target
-- mirrors the existing deleted_by uuid REFERENCES profiles(id) convention
-- (mig 067). Partial indexes support the ownership lookups the RPCs run.
-- ============================================================================

-- Daily report tables --------------------------------------------------------
ALTER TABLE public.poultry_dailys ADD COLUMN IF NOT EXISTS owner_profile_id uuid REFERENCES public.profiles(id);
ALTER TABLE public.layer_dailys   ADD COLUMN IF NOT EXISTS owner_profile_id uuid REFERENCES public.profiles(id);
ALTER TABLE public.egg_dailys     ADD COLUMN IF NOT EXISTS owner_profile_id uuid REFERENCES public.profiles(id);
ALTER TABLE public.pig_dailys     ADD COLUMN IF NOT EXISTS owner_profile_id uuid REFERENCES public.profiles(id);
ALTER TABLE public.cattle_dailys  ADD COLUMN IF NOT EXISTS owner_profile_id uuid REFERENCES public.profiles(id);
ALTER TABLE public.sheep_dailys   ADD COLUMN IF NOT EXISTS owner_profile_id uuid REFERENCES public.profiles(id);

-- Add Feed parent + equipment fueling + fuel supply --------------------------
ALTER TABLE public.daily_submissions  ADD COLUMN IF NOT EXISTS owner_profile_id uuid REFERENCES public.profiles(id);
ALTER TABLE public.equipment_fuelings ADD COLUMN IF NOT EXISTS owner_profile_id uuid REFERENCES public.profiles(id);
ALTER TABLE public.fuel_supplies      ADD COLUMN IF NOT EXISTS owner_profile_id uuid REFERENCES public.profiles(id);

-- Ownership-lookup indexes ---------------------------------------------------
-- Dailies carry a deleted_at active filter; the others do not.
CREATE INDEX IF NOT EXISTS poultry_dailys_owner_idx ON public.poultry_dailys (owner_profile_id)
  WHERE deleted_at IS NULL AND owner_profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS layer_dailys_owner_idx ON public.layer_dailys (owner_profile_id)
  WHERE deleted_at IS NULL AND owner_profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS egg_dailys_owner_idx ON public.egg_dailys (owner_profile_id)
  WHERE deleted_at IS NULL AND owner_profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pig_dailys_owner_idx ON public.pig_dailys (owner_profile_id)
  WHERE deleted_at IS NULL AND owner_profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cattle_dailys_owner_idx ON public.cattle_dailys (owner_profile_id)
  WHERE deleted_at IS NULL AND owner_profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sheep_dailys_owner_idx ON public.sheep_dailys (owner_profile_id)
  WHERE deleted_at IS NULL AND owner_profile_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS daily_submissions_owner_idx ON public.daily_submissions (owner_profile_id)
  WHERE owner_profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS equipment_fuelings_owner_idx ON public.equipment_fuelings (owner_profile_id)
  WHERE owner_profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fuel_supplies_owner_idx ON public.fuel_supplies (owner_profile_id)
  WHERE owner_profile_id IS NOT NULL;
