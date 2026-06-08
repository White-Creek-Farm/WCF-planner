import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// ============================================================================
// Equipment fueling RPC — mig 047 + EquipmentFuelingWebform wiring lock
// ============================================================================
// Public /equipment/<slug> submissions previously did a synchronous .insert
// on equipment_fuelings + a .then(() => {})-silenced .update on
// equipment.current_hours/current_km. Anon RLS denies that UPDATE (mig 016
// has only equipment_auth_all + equipment_anon_read), so the parent row
// drifted on every public submission. Mig 047 ships a SECURITY DEFINER RPC
// that does both writes atomically with anon EXECUTE, plus a one-shot
// historical reconciliation. The webform now calls the RPC and surfaces
// errors instead of silencing the parent UPDATE.
//
// Locks (this static test):
//   1. Mig 047 contract — function shape, search_path, validation,
//      idempotency, GREATEST update, anon EXECUTE, reconciliation CTE.
//   2. EquipmentFuelingWebform RPC wiring — RPC name + parent_in shape +
//      stable client_submission_id + reading-required client validation +
//      no remaining direct anon UPDATE on equipment.
//   3. equipment.js latestSaneReading helper retained as defensive fallback.
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const migSrc = fs.readFileSync(path.join(ROOT, 'supabase-migrations/047_equipment_fueling_rpc.sql'), 'utf8');
const formSrc = fs.readFileSync(path.join(ROOT, 'src/webforms/EquipmentFuelingWebform.jsx'), 'utf8');
const equipmentLibSrc = fs.readFileSync(path.join(ROOT, 'src/lib/equipment.js'), 'utf8');

describe('Mig 047 — submit_equipment_fueling RPC contract', () => {
  // Anchor on the function body so unrelated SQL doesn't false-match.
  const fn = migSrc.match(
    /CREATE OR REPLACE FUNCTION public\.submit_equipment_fueling\(\s*parent_in jsonb\s*\)[\s\S]*?\$equipment_fueling\$;/,
  );
  it('CREATE OR REPLACE FUNCTION public.submit_equipment_fueling(parent_in jsonb)', () => {
    expect(fn, 'expected submit_equipment_fueling function definition').not.toBeNull();
  });

  const body = fn ? fn[0] : '';

  it('SECURITY DEFINER + SET search_path = public', () => {
    expect(body).toMatch(/SECURITY DEFINER/);
    expect(body).toMatch(/SET search_path = public/);
  });

  it('uses tagged dollar-quote $equipment_fueling$ (not plain $$, avoids exec_sql nesting collision)', () => {
    expect(body).toMatch(/\$equipment_fueling\$/);
  });

  it('rejects missing required identity / parent fields with explicit RAISE messages', () => {
    expect(body).toMatch(/'submit_equipment_fueling: client_submission_id required'/);
    expect(body).toMatch(/'submit_equipment_fueling: id required'/);
    expect(body).toMatch(/'submit_equipment_fueling: equipment_id required'/);
    expect(body).toMatch(/'submit_equipment_fueling: date required'/);
    expect(body).toMatch(/'submit_equipment_fueling: team_member required'/);
    expect(body).toMatch(/'submit_equipment_fueling: gallons required'/);
  });

  it('rejects gallons <= 0 (numeric validation)', () => {
    expect(body).toMatch(/gallons must be > 0/);
  });

  it('rejects unknown / inactive equipment_id', () => {
    expect(body).toMatch(/'submit_equipment_fueling: equipment_id % not found'/);
    expect(body).toMatch(/equipment % is not active/);
  });

  it('tracking_unit=hours requires hours_reading > 0 and ignores km_reading', () => {
    expect(body).toMatch(/hours_reading required for tracking_unit=hours/);
    expect(body).toMatch(/hours_reading must be > 0/);
    // The km_reading nulling for hours-tracked pieces is structural — locked
    // by the comment + the v_km_reading := NULL line in the body.
    expect(body).toMatch(/v_km_reading\s*:=\s*NULL/);
  });

  it('tracking_unit=km requires km_reading > 0 and ignores hours_reading', () => {
    expect(body).toMatch(/km_reading required for tracking_unit=km/);
    expect(body).toMatch(/km_reading must be > 0/);
    expect(body).toMatch(/v_hours_reading\s*:=\s*NULL/);
  });

  it('race-safe idempotent insert: ON CONFLICT (client_submission_id) DO NOTHING + fallback SELECT', () => {
    expect(body).toMatch(/ON CONFLICT \(client_submission_id\) DO NOTHING/);
    expect(body).toMatch(/RETURNING id INTO v_inserted/);
    expect(body).toMatch(/idempotent_replay/);
  });

  it('GREATEST / only-go-forward parent bump on equipment.current_<unit>', () => {
    expect(body).toMatch(/GREATEST\(coalesce\(current_hours, 0\), v_hours_reading\)/);
    expect(body).toMatch(/GREATEST\(coalesce\(current_km, 0\), v_km_reading\)/);
    // Guard so the UPDATE no-ops when current_* is already >= the new reading.
    expect(body).toMatch(/current_hours IS NULL OR current_hours < v_hours_reading/);
    expect(body).toMatch(/current_km IS NULL OR current_km < v_km_reading/);
  });

  it('returns {fueling_id, idempotent_replay, equipment_reading_updated}', () => {
    expect(body).toMatch(
      /jsonb_build_object\([\s\S]*?'fueling_id'[\s\S]*?'idempotent_replay'[\s\S]*?'equipment_reading_updated'/,
    );
  });

  it('REVOKE ALL FROM public + GRANT EXECUTE TO anon, authenticated', () => {
    expect(migSrc).toMatch(/REVOKE ALL ON FUNCTION public\.submit_equipment_fueling\(jsonb\) FROM public/);
    expect(migSrc).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.submit_equipment_fueling\(jsonb\) TO anon, authenticated/,
    );
  });

  it('does NOT grant any new policy on equipment (anon UPDATE stays closed)', () => {
    // Mig 047 must not introduce equipment-update policies for anon. Search
    // the migration file for any policy line that targets anon + equipment.
    expect(migSrc).not.toMatch(/CREATE POLICY[\s\S]*?ON public\.equipment\b[\s\S]*?TO anon[\s\S]*?FOR (UPDATE|ALL)/);
  });
});

describe('Mig 047 — historical reconciliation CTE', () => {
  it('walks active equipment and aligns current_<unit> to latest-by-date fueling reading', () => {
    expect(migSrc).toMatch(/WITH latest_per_eq AS \(/);
    expect(migSrc).toMatch(/SELECT DISTINCT ON \(ef\.equipment_id, eq\.tracking_unit\)/);
    expect(migSrc).toMatch(/ORDER BY ef\.equipment_id, eq\.tracking_unit, ef\.date DESC/);
  });

  it('only updates when latest reading is greater than parent (or parent is null)', () => {
    expect(migSrc).toMatch(/e\.current_hours IS NULL OR e\.current_hours < l\.latest_reading/);
    expect(migSrc).toMatch(/e\.current_km\s+IS NULL OR e\.current_km\s+< l\.latest_reading/);
  });

  it('scopes the reconciliation to status=active equipment only', () => {
    expect(migSrc).toMatch(/eq\.status = 'active'/);
    expect(migSrc).toMatch(/e\.status = 'active'/);
  });
});

describe('EquipmentFuelingWebform — offline RPC wiring + client validation', () => {
  // Lane H: submission moved off the direct sb.rpc call onto the parent-aware
  // offline RPC queue (useOfflineRpcSubmit('equipment_fueling')). The RPC
  // contract (mig 047) is unchanged — only the client transport changed.
  it("submits through useOfflineRpcSubmit('equipment_fueling')", () => {
    expect(formSrc).toMatch(/import\s*\{\s*useOfflineRpcSubmit\s*\}\s*from\s*'\.\.\/lib\/useOfflineRpcSubmit\.js'/);
    expect(formSrc).toMatch(/useOfflineRpcSubmit\(\s*'equipment_fueling'\s*\)/);
  });

  it('no longer calls sb.rpc directly for the fueling submit (queue owns the call)', () => {
    expect(formSrc).not.toMatch(/sb\.rpc\(\s*'submit_equipment_fueling'/);
  });

  it('no longer mints the csid inline (the hook owns client_submission_id + parent id)', () => {
    expect(formSrc).not.toMatch(/newClientSubmissionId/);
    expect(formSrc).not.toMatch(/client_submission_id:/);
  });

  it('tracks doneState (none/synced/queued) instead of a boolean done flag', () => {
    expect(formSrc).toMatch(/setDoneState\(/);
    expect(formSrc).toMatch(/data-submit-state=\{doneState\}/);
    expect(formSrc).not.toMatch(/const \[done, setDone\]/);
  });

  it('surfaces stuck submissions via StuckSubmissionsModal + a stuck CTA', () => {
    expect(formSrc).toMatch(/import\s+StuckSubmissionsModal\s+from\s+'\.\/StuckSubmissionsModal\.jsx'/);
    expect(formSrc).toMatch(/<StuckSubmissionsModal/);
    expect(formSrc).toMatch(/data-stuck-button="1"/);
  });

  it('rejects blank reading client-side before queuing the submit', () => {
    // The previously-loose hasReading guard now surfaces "Current Hours/KM
    // required" before invoking the RPC. Anchor on the inline error message.
    expect(formSrc).toMatch(/Current\s*'\s*\+\s*readingLabel\s*\+\s*'\s*required/);
  });

  it('no longer does the silent .then(() => {}) UPDATE on equipment', () => {
    // The drift-causing pattern was sb.from('equipment').update(upd)... .then(() => {}).
    // Locking the absence of any direct .update() call to the equipment
    // table in this file.
    expect(formSrc).not.toMatch(/from\('equipment'\)\.update/);
    expect(formSrc).not.toMatch(/\.then\(\(\)\s*=>\s*\{\}\)/);
  });

  it('no longer does a direct .insert into equipment_fuelings (RPC owns the insert)', () => {
    expect(formSrc).not.toMatch(/from\('equipment_fuelings'\)\.insert/);
  });
});

describe('equipment.js — latestSaneReading retained as defensive fallback', () => {
  it('the helper still exists and is exported', () => {
    expect(equipmentLibSrc).toMatch(/export function latestSaneReading\(eq, fuelings\)/);
  });

  it("comment references mig 047 / 2026-05-06 fix and 'defensive fallback' role", () => {
    expect(equipmentLibSrc).toMatch(/[Mm]ig 047/);
    expect(equipmentLibSrc).toMatch(/defensive fallback/);
  });
});
