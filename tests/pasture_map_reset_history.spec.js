// Pasture Map — per-entry grazing delete + parent-from-child coloring (mig 147).
// Build Queue item 1 replaced the per-AREA "Reset grazing history" button with a
// per-ENTRY delete in the renamed "Grazing History" card (management/admin), and
// fixed parent pastures taking occupied/resting FILL from their child paddocks.
//
// Seeds the move ledger directly (service role cannot call the auth.uid()-gated
// record RPC): a move INTO the child paddock writes a destination impact on the
// child AND an overlap impact on the parent (exactly what record_pasture_move
// does), so the parent would wrongly read "occupied" without the fix.
import {test, expect} from '@playwright/test';
import {getTestAdminClient} from './setup/reset.js';

const P_ID = 'pm-rst-pasture';
const C_ID = 'pm-rst-paddock';
const MV_ID = 'pm-rst-move-1';
const MV_OUT_ID = 'pm-rst-move-2';

const POLY_P =
  '{"type":"Polygon","coordinates":[[[-86.44,30.84],[-86.43,30.84],[-86.43,30.85],[-86.44,30.85],[-86.44,30.84]]]}';
const POLY_C =
  '{"type":"Polygon","coordinates":[[[-86.438,30.842],[-86.434,30.842],[-86.434,30.846],[-86.438,30.846],[-86.438,30.842]]]}';

async function seed() {
  const c = getTestAdminClient();
  const sql = `
    TRUNCATE TABLE public.pasture_planned_moves, public.pasture_move_impacts,
      public.pasture_move_events, public.land_area_geometry_versions,
      public.pasture_import_batches, public.land_areas RESTART IDENTITY CASCADE;
    DO $$
    DECLARE v_profile uuid;
    BEGIN
      SELECT id INTO v_profile FROM public.profiles LIMIT 1;
      -- Parent baseline_no_history=false mirrors record_pasture_move flipping it
      -- when it writes the parent's overlap impact.
      INSERT INTO public.land_areas
        (id, kind, name, parent_id, permanence, status, review_status, geometry_status, baseline_no_history, source, created_by)
      VALUES
        ('${P_ID}', 'pasture', 'Reset Pasture', NULL, 'permanent', 'active', 'reviewed', 'none', false, 'drawn', v_profile),
        ('${C_ID}', 'paddock', 'Reset Paddock 1', '${P_ID}', 'permanent', 'active', 'reviewed', 'none', false, 'drawn', v_profile);
      PERFORM public._land_area_add_version('${P_ID}', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${POLY_P}'),4326), 'drawn', '{}'::jsonb, v_profile);
      PERFORM public._land_area_add_version('${C_ID}', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${POLY_C}'),4326), 'drawn', '{}'::jsonb, v_profile);
      -- A move INTO the paddock: destination impact on the child + overlap impact on
      -- the containing parent pasture (what record_pasture_move records).
      INSERT INTO public.pasture_move_events
        (id, animal_type, group_key, group_label, to_land_area_id, moved_at, animal_count, created_by)
      VALUES
        ('${MV_ID}', 'cattle_herd', 'reset-test', 'Reset Test Group', '${C_ID}', now() - interval '2 days', 10, v_profile);
      INSERT INTO public.pasture_move_impacts (move_id, land_area_id, impact_kind, impacted_at)
      VALUES
        ('${MV_ID}', '${C_ID}', 'destination', now() - interval '2 days'),
        ('${MV_ID}', '${P_ID}', 'overlap', now() - interval '2 days');
    END $$;
  `;
  const {error} = await c.rpc('exec_sql', {sql});
  if (error) throw new Error('seed grazing-delete: ' + error.message);
}

// COMPLETED stay: a move INTO the child (M1), then a CLEAR move OUT of it (M2).
// M2 carries departure impacts on the child AND the parent (derived from M1's
// touched areas), so the child reads "resting". Deleting the M1 entry must also
// clear M2's linked departures or the child would stay "resting" with no stay.
async function seedCompleted() {
  const c = getTestAdminClient();
  const sql = `
    TRUNCATE TABLE public.pasture_planned_moves, public.pasture_move_impacts,
      public.pasture_move_events, public.land_area_geometry_versions,
      public.pasture_import_batches, public.land_areas RESTART IDENTITY CASCADE;
    DO $$
    DECLARE v_profile uuid;
    BEGIN
      SELECT id INTO v_profile FROM public.profiles LIMIT 1;
      INSERT INTO public.land_areas
        (id, kind, name, parent_id, permanence, status, review_status, geometry_status, baseline_no_history, source, created_by)
      VALUES
        ('${P_ID}', 'pasture', 'Reset Pasture', NULL, 'permanent', 'active', 'reviewed', 'none', false, 'drawn', v_profile),
        ('${C_ID}', 'paddock', 'Reset Paddock 1', '${P_ID}', 'permanent', 'active', 'reviewed', 'none', false, 'drawn', v_profile);
      PERFORM public._land_area_add_version('${P_ID}', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${POLY_P}'),4326), 'drawn', '{}'::jsonb, v_profile);
      PERFORM public._land_area_add_version('${C_ID}', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${POLY_C}'),4326), 'drawn', '{}'::jsonb, v_profile);
      INSERT INTO public.pasture_move_events
        (id, animal_type, group_key, group_label, from_land_area_id, to_land_area_id, moved_at, animal_count, created_by)
      VALUES
        ('${MV_ID}', 'cattle_herd', 'reset-test', 'Reset Test Group', NULL, '${C_ID}', now() - interval '5 days', 10, v_profile),
        ('${MV_OUT_ID}', 'cattle_herd', 'reset-test', 'Reset Test Group', '${C_ID}', NULL, now() - interval '2 days', 10, v_profile);
      INSERT INTO public.pasture_move_impacts (move_id, land_area_id, impact_kind, impacted_at)
      VALUES
        ('${MV_ID}', '${C_ID}', 'destination', now() - interval '5 days'),
        ('${MV_ID}', '${P_ID}', 'overlap', now() - interval '5 days'),
        ('${MV_OUT_ID}', '${C_ID}', 'departure', now() - interval '2 days'),
        ('${MV_OUT_ID}', '${P_ID}', 'departure', now() - interval '2 days');
    END $$;
  `;
  const {error} = await c.rpc('exec_sql', {sql});
  if (error) throw new Error('seed completed-stay: ' + error.message);
}

async function hideMapOverlays(page) {
  await page.addStyleTag({
    content:
      '.pm-boundary-toggle,.pm-map-controls,.pm-legend,.pm-draftlines-toggle,.pm-map-banner{display:none!important}',
  });
}

test.beforeAll(seed);

test('Reports: parent ignores child fill (mig 147), and a per-entry delete clears the stay', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});
  await expect(page.locator(`.pm-area-${C_ID}`).first()).toBeVisible({timeout: 25_000});
  await hideMapOverlays(page);

  await page.locator('.pm-tabs button', {hasText: 'Reports'}).click();
  await expect(page.locator('[data-pasture-report-areas]')).toBeVisible({timeout: 15_000});
  await page.locator(`[data-pasture-report-pasture="${P_ID}"] > summary`).click();

  // COLOR FIX: the PARENT pasture record reads "No grazing history yet" — it did NOT
  // take occupied/grazed state from the child paddock's move (overlap suppressed).
  await page.locator(`[data-pasture-report-area-row="${P_ID}"]`).click();
  await expect(page.locator(`[data-pasture-report-record="${P_ID}"]`)).toBeVisible({timeout: 15_000});
  await expect(page.locator('[data-pasture-report-status]')).toContainText('No grazing history yet');
  await page.locator('[data-pasture-report-back]').click();

  // Back returns to the list and the native <details> re-renders collapsed; re-expand.
  await expect(page.locator('[data-pasture-report-areas]')).toBeVisible({timeout: 15_000});
  await page.locator(`[data-pasture-report-pasture="${P_ID}"] > summary`).click();

  // The CHILD paddock record is "In use" and the renamed Grazing History card lists
  // the stay with a per-entry delete control.
  await page.locator(`[data-pasture-report-area-row="${C_ID}"]`).click();
  await expect(page.locator(`[data-pasture-report-record="${C_ID}"]`)).toBeVisible({timeout: 15_000});
  await expect(page.locator('[data-pasture-report-timeline]')).toContainText('Grazing History');
  await expect(page.locator('[data-pasture-report-status]')).toContainText('In use');
  await expect(page.locator('[data-pasture-report-stay]').first()).toContainText('Reset Test Group');

  // Per-entry delete: click delete -> confirm -> the stay disappears and the area
  // reads no-history again.
  await page.locator(`[data-pasture-report-stay-delete="${MV_ID}"]`).click();
  await page.locator(`[data-pasture-report-stay-delete-yes="${MV_ID}"]`).click();
  await expect(page.locator('[data-pasture-report-stay]')).toHaveCount(0, {timeout: 15_000});
  await expect(page.locator('[data-pasture-report-status]')).toContainText('No grazing history yet');

  // Server-side: the move event is gone and its impacts cascaded for BOTH areas.
  await expect
    .poll(
      async () => {
        const c = getTestAdminClient();
        const {data: ev} = await c.from('pasture_move_events').select('id').eq('id', MV_ID);
        const {data: imp} = await c.from('pasture_move_impacts').select('move_id').eq('move_id', MV_ID);
        return (ev || []).length + (imp || []).length;
      },
      {timeout: 15_000},
    )
    .toBe(0);
});

test('Reports: deleting a COMPLETED stay clears the orphaned resting state (no drift)', async ({page}) => {
  await seedCompleted();
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});
  await expect(page.locator(`.pm-area-${C_ID}`).first()).toBeVisible({timeout: 25_000});
  await hideMapOverlays(page);

  await page.locator('.pm-tabs button', {hasText: 'Reports'}).click();
  await expect(page.locator('[data-pasture-report-areas]')).toBeVisible({timeout: 15_000});
  await page.locator(`[data-pasture-report-pasture="${P_ID}"] > summary`).click();
  await page.locator(`[data-pasture-report-area-row="${C_ID}"]`).click();
  await expect(page.locator(`[data-pasture-report-record="${C_ID}"]`)).toBeVisible({timeout: 15_000});

  // The completed stay is recorded and the child currently reads RESTING (its
  // move-OUT departure). The stay shows an end (not "Still here").
  await expect(page.locator('[data-pasture-report-stay]').first()).toContainText('Reset Test Group');
  await expect(page.locator('[data-pasture-report-stay]').first()).not.toContainText('Still here');
  await expect(page.locator('.pm-record-rest')).toContainText('resting');

  // Delete the move-IN entry. The drift fix also clears the move-OUT's linked
  // departures, so the child stops reading "resting" (now no move history) instead
  // of staying amber with no stay behind it.
  await page.locator(`[data-pasture-report-stay-delete="${MV_ID}"]`).click();
  await page.locator(`[data-pasture-report-stay-delete-yes="${MV_ID}"]`).click();
  await expect(page.locator('[data-pasture-report-stay]')).toHaveCount(0, {timeout: 15_000});
  await expect(page.locator('.pm-record-rest')).toContainText('No move history');

  // Server-side: M1 + its impacts gone; the later move-OUT survives but its linked
  // departures are cleared (so nothing keeps the child resting).
  await expect
    .poll(
      async () => {
        const c = getTestAdminClient();
        const {data: ev1} = await c.from('pasture_move_events').select('id').eq('id', MV_ID);
        const {data: imp1} = await c.from('pasture_move_impacts').select('move_id').eq('move_id', MV_ID);
        const {data: ev2} = await c.from('pasture_move_events').select('id').eq('id', MV_OUT_ID);
        const {data: imp2} = await c.from('pasture_move_impacts').select('move_id').eq('move_id', MV_OUT_ID);
        return {
          m1: (ev1 || []).length,
          m1imp: (imp1 || []).length,
          m2: (ev2 || []).length,
          m2imp: (imp2 || []).length,
        };
      },
      {timeout: 15_000},
    )
    .toEqual({m1: 0, m1imp: 0, m2: 1, m2imp: 0});
});
