-- ============================================================================
-- Migration 047: submit_equipment_fueling RPC + historical reconciliation
-- ----------------------------------------------------------------------------
-- Background: the public /equipment/<slug> (was /fueling/<slug> pre-rename)
-- form INSERTs into equipment_fuelings AND tries to UPDATE
-- equipment.current_hours / current_km on the parent row. The UPDATE is
-- silently rejected by RLS — equipment has only equipment_auth_all
-- (authenticated FOR ALL) and equipment_anon_read (anon SELECT) per mig 016.
-- Result: prod equipment.current_* drifts behind the actual fueling reading
-- whenever an operator submits. Recon 2026-05-06 found 7 of 16 active pieces
-- drifted, with 5065 drifting on the same day.
--
-- The shipped read-side workaround (src/lib/equipment.js latestSaneReading)
-- compensates for HomeDashboard's overdue-interval math but four other
-- consumers — FuelingHub tile, EquipmentDetail, EquipmentFleetView, and
-- EquipmentMaintenanceModal prefill — read equipment.current_* directly and
-- show stale values.
--
-- Fix: a SECURITY DEFINER RPC `submit_equipment_fueling(parent_in jsonb)` that
-- INSERTs the equipment_fuelings row AND updates equipment.current_<unit> in
-- one atomic transaction with anon EXECUTE. Mirrors mig 034 / 035 / 041 /
-- 042 patterns:
--   * race-safe idempotency via ON CONFLICT (client_submission_id) DO NOTHING
--     RETURNING id + fallback SELECT — no 23505 ever surfaces;
--   * tagged dollar-quote $equipment_fueling$ so the test bootstrap's
--     exec_sql (defined with plain $$) can EXECUTE this migration without
--     nested-quote collisions;
--   * RAISE EXCEPTION for every required-field / shape violation with a
--     specific message rather than letting a generic constraint failure
--     surface to the caller.
--
-- GREATEST / only-go-forward semantic:
--   The UPDATE uses GREATEST(coalesce(equipment.current_<unit>, 0), <new>),
--   so a public submission can only RAISE the parent reading. Backwards-clock
--   submissions or out-of-order replay never reduce current_*. Admins can
--   still bump the parent down via the authenticated /fleet detail page if
--   a corrected reading is needed. NULL parent reading on a freshly imported
--   piece is treated as 0 — first submission wins and seeds the parent.
--
-- Existing RLS / policies NOT touched:
--   * equipment retains equipment_auth_all + equipment_anon_read. No anon
--     UPDATE policy is added — the RPC's SECURITY DEFINER context is the
--     update path.
--   * equipment_fuelings retains equipment_fuelings_anon_insert from mig 016.
--     The form continues to work even if a future caller wants to bypass the
--     RPC for some reason; this migration ADDS the RPC, it does not remove
--     the direct anon insert path.
--   * No storage policy changes.
--
-- Reconciliation CTE (one-shot, idempotent):
--   At the end of the migration, run a generic latest-by-date reconciliation
--   over every active equipment row. For each piece, find the latest
--   equipment_fuelings reading in the right unit (hours or km) and bump
--   equipment.current_<unit> only when the latest reading is GREATER than
--   the parent (or the parent is NULL). Same semantics latestSaneReading and
--   scripts/recon_initiative_c.cjs use. Safe to re-run: subsequent passes
--   are no-ops once alignment is achieved.
--
-- Idempotent: CREATE OR REPLACE FUNCTION + the reconciliation CTE's GREATER-
-- THAN guard. Safe to apply more than once.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.submit_equipment_fueling(
  parent_in jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $equipment_fueling$
DECLARE
  v_csid               text;
  v_id                 text;
  v_equipment_id       text;
  v_date               text;
  v_team_member        text;
  v_gallons_raw        text;
  v_gallons            numeric;
  v_def_gallons_raw    text;
  v_def_gallons        numeric;
  v_fuel_cost_raw      text;
  v_fuel_cost          numeric;
  v_hours_raw          text;
  v_km_raw             text;
  v_hours_reading      numeric;
  v_km_reading         numeric;
  v_tracking_unit      text;
  v_status             text;
  v_inserted           text;
  v_existing_id        text;
  v_update_rows        int;
  v_reading_updated    boolean := false;
BEGIN
  v_csid          := parent_in ->> 'client_submission_id';
  v_id            := parent_in ->> 'id';
  v_equipment_id  := parent_in ->> 'equipment_id';
  v_date          := parent_in ->> 'date';
  v_team_member   := parent_in ->> 'team_member';
  v_gallons_raw   := parent_in ->> 'gallons';
  v_def_gallons_raw := parent_in ->> 'def_gallons';
  v_fuel_cost_raw := parent_in ->> 'fuel_cost_per_gal';
  v_hours_raw     := parent_in ->> 'hours_reading';
  v_km_raw        := parent_in ->> 'km_reading';

  -- Identity / parent-shape validation. Match mig 034 / 035 message style:
  -- "<function>: <field> required" so the offline-queue classifier can
  -- distinguish schema-class failures from runtime errors.
  IF v_csid IS NULL OR v_csid = '' THEN
    RAISE EXCEPTION 'submit_equipment_fueling: client_submission_id required';
  END IF;
  IF v_id IS NULL OR v_id = '' THEN
    RAISE EXCEPTION 'submit_equipment_fueling: id required';
  END IF;
  IF v_equipment_id IS NULL OR v_equipment_id = '' THEN
    RAISE EXCEPTION 'submit_equipment_fueling: equipment_id required';
  END IF;
  IF v_date IS NULL OR v_date = '' THEN
    RAISE EXCEPTION 'submit_equipment_fueling: date required';
  END IF;
  IF v_team_member IS NULL OR btrim(v_team_member) = '' THEN
    RAISE EXCEPTION 'submit_equipment_fueling: team_member required';
  END IF;

  -- Numeric validation.
  IF v_gallons_raw IS NULL OR v_gallons_raw = '' THEN
    RAISE EXCEPTION 'submit_equipment_fueling: gallons required';
  END IF;
  BEGIN
    v_gallons := v_gallons_raw::numeric;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'submit_equipment_fueling: gallons must be numeric; got %', v_gallons_raw;
  END;
  IF v_gallons <= 0 THEN
    RAISE EXCEPTION 'submit_equipment_fueling: gallons must be > 0; got %', v_gallons;
  END IF;

  -- Optional numerics: parse only if present.
  IF v_def_gallons_raw IS NOT NULL AND v_def_gallons_raw <> '' THEN
    BEGIN
      v_def_gallons := v_def_gallons_raw::numeric;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'submit_equipment_fueling: def_gallons must be numeric; got %', v_def_gallons_raw;
    END;
    IF v_def_gallons <= 0 THEN
      v_def_gallons := NULL;
    END IF;
  END IF;
  IF v_fuel_cost_raw IS NOT NULL AND v_fuel_cost_raw <> '' THEN
    BEGIN
      v_fuel_cost := v_fuel_cost_raw::numeric;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'submit_equipment_fueling: fuel_cost_per_gal must be numeric; got %', v_fuel_cost_raw;
    END;
  END IF;

  -- Equipment lookup + status guard.
  SELECT tracking_unit, status
    INTO v_tracking_unit, v_status
    FROM public.equipment
   WHERE id = v_equipment_id;

  IF v_tracking_unit IS NULL THEN
    RAISE EXCEPTION 'submit_equipment_fueling: equipment_id % not found', v_equipment_id;
  END IF;
  IF v_status <> 'active' THEN
    RAISE EXCEPTION 'submit_equipment_fueling: equipment % is not active (status=%)', v_equipment_id, v_status;
  END IF;

  -- Reading validation: tracking_unit dictates which reading column is
  -- required and which is coerced to NULL on insert. A submission for an
  -- hours-tracked piece that includes only km_reading is rejected — the
  -- public form's input is the equipment's tracking unit by construction,
  -- so a unit mismatch is a programming error, not operator input.
  IF v_tracking_unit = 'hours' THEN
    IF v_hours_raw IS NULL OR v_hours_raw = '' THEN
      RAISE EXCEPTION 'submit_equipment_fueling: hours_reading required for tracking_unit=hours';
    END IF;
    BEGIN
      v_hours_reading := v_hours_raw::numeric;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'submit_equipment_fueling: hours_reading must be numeric; got %', v_hours_raw;
    END;
    IF v_hours_reading <= 0 THEN
      RAISE EXCEPTION 'submit_equipment_fueling: hours_reading must be > 0; got %', v_hours_reading;
    END IF;
    -- km_reading is ignored for hours-tracked pieces.
    v_km_reading := NULL;
  ELSIF v_tracking_unit = 'km' THEN
    IF v_km_raw IS NULL OR v_km_raw = '' THEN
      RAISE EXCEPTION 'submit_equipment_fueling: km_reading required for tracking_unit=km';
    END IF;
    BEGIN
      v_km_reading := v_km_raw::numeric;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'submit_equipment_fueling: km_reading must be numeric; got %', v_km_raw;
    END;
    IF v_km_reading <= 0 THEN
      RAISE EXCEPTION 'submit_equipment_fueling: km_reading must be > 0; got %', v_km_reading;
    END IF;
    -- hours_reading is ignored for km-tracked pieces.
    v_hours_reading := NULL;
  ELSE
    RAISE EXCEPTION 'submit_equipment_fueling: equipment % has unrecognized tracking_unit %', v_equipment_id, v_tracking_unit;
  END IF;

  -- Race-safe idempotent insert into equipment_fuelings. Mirrors mig 034 /
  -- 035 / 041 patterns — ON CONFLICT (client_submission_id) DO NOTHING +
  -- fallback SELECT. No 23505 ever surfaces.
  INSERT INTO public.equipment_fuelings (
    id,
    podio_item_id,
    podio_source_app,
    equipment_id,
    date,
    team_member,
    fuel_type,
    gallons,
    fuel_cost_per_gal,
    def_gallons,
    hours_reading,
    km_reading,
    every_fillup_check,
    service_intervals_completed,
    photos,
    comments,
    source,
    client_submission_id
  ) VALUES (
    v_id,
    NULL,
    parent_in ->> 'podio_source_app',
    v_equipment_id,
    v_date::date,
    btrim(v_team_member),
    parent_in ->> 'fuel_type',
    v_gallons,
    v_fuel_cost,
    v_def_gallons,
    v_hours_reading,
    v_km_reading,
    coalesce(parent_in -> 'every_fillup_check', '[]'::jsonb),
    coalesce(parent_in -> 'service_intervals_completed', '[]'::jsonb),
    coalesce(parent_in -> 'photos', '[]'::jsonb),
    parent_in ->> 'comments',
    coalesce(parent_in ->> 'source', 'fuel_log_webform'),
    v_csid
  )
  ON CONFLICT (client_submission_id) DO NOTHING
  RETURNING id INTO v_inserted;

  IF v_inserted IS NULL THEN
    -- Replay: a previous call with this csid already landed. Look up the
    -- existing row's id and short-circuit. No equipment update on replay —
    -- the parent was already bumped on the original call.
    SELECT id INTO v_existing_id
      FROM public.equipment_fuelings
     WHERE client_submission_id = v_csid;
    RETURN jsonb_build_object(
      'fueling_id',                v_existing_id,
      'idempotent_replay',         true,
      'equipment_reading_updated', false
    );
  END IF;

  -- GREATEST / only-go-forward parent bump. NULL parent on a fresh import is
  -- coerced to 0 so the first submission seeds the value. Backwards-clock or
  -- out-of-order replay can't reduce current_*. Admin corrections downward
  -- still go through authenticated /fleet detail UPDATE.
  IF v_tracking_unit = 'hours' THEN
    UPDATE public.equipment
       SET current_hours = GREATEST(coalesce(current_hours, 0), v_hours_reading)
     WHERE id = v_equipment_id
       AND (current_hours IS NULL OR current_hours < v_hours_reading);
    GET DIAGNOSTICS v_update_rows = ROW_COUNT;
  ELSE
    UPDATE public.equipment
       SET current_km = GREATEST(coalesce(current_km, 0), v_km_reading)
     WHERE id = v_equipment_id
       AND (current_km IS NULL OR current_km < v_km_reading);
    GET DIAGNOSTICS v_update_rows = ROW_COUNT;
  END IF;
  v_reading_updated := v_update_rows > 0;

  RETURN jsonb_build_object(
    'fueling_id',                v_id,
    'idempotent_replay',         false,
    'equipment_reading_updated', v_reading_updated
  );
END;
$equipment_fueling$;

REVOKE ALL ON FUNCTION public.submit_equipment_fueling(jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_equipment_fueling(jsonb) TO anon, authenticated;

-- ----------------------------------------------------------------------------
-- One-shot historical reconciliation
-- ----------------------------------------------------------------------------
-- For every active equipment row, find the latest equipment_fuelings reading
-- in the right unit and align equipment.current_<unit> when the latest
-- reading is GREATER than the parent (or the parent is NULL). Matches
-- latestSaneReading + recon_initiative_c semantics (latest-by-date, not
-- max-reading — protects against legacy import outliers like the
-- honda-atv-1 5437h row from 2025-01-11 where the actual most-recent
-- fueling is ~1086h). Idempotent: subsequent runs are no-ops.

WITH latest_per_eq AS (
  SELECT DISTINCT ON (ef.equipment_id, eq.tracking_unit)
         ef.equipment_id,
         eq.tracking_unit,
         CASE
           WHEN eq.tracking_unit = 'hours' THEN ef.hours_reading
           WHEN eq.tracking_unit = 'km'    THEN ef.km_reading
         END AS latest_reading
    FROM public.equipment_fuelings ef
    JOIN public.equipment eq ON eq.id = ef.equipment_id
   WHERE eq.status = 'active'
     AND CASE
           WHEN eq.tracking_unit = 'hours' THEN ef.hours_reading
           WHEN eq.tracking_unit = 'km'    THEN ef.km_reading
         END IS NOT NULL
   ORDER BY ef.equipment_id, eq.tracking_unit, ef.date DESC, ef.submitted_at DESC
)
UPDATE public.equipment AS e
   SET current_hours = CASE
         WHEN e.tracking_unit = 'hours' THEN GREATEST(coalesce(e.current_hours, 0), l.latest_reading)
         ELSE e.current_hours
       END,
       current_km = CASE
         WHEN e.tracking_unit = 'km' THEN GREATEST(coalesce(e.current_km, 0), l.latest_reading)
         ELSE e.current_km
       END
  FROM latest_per_eq l
 WHERE e.id = l.equipment_id
   AND e.status = 'active'
   AND (
         (e.tracking_unit = 'hours' AND (e.current_hours IS NULL OR e.current_hours < l.latest_reading))
      OR (e.tracking_unit = 'km'    AND (e.current_km    IS NULL OR e.current_km    < l.latest_reading))
       );

COMMIT;
