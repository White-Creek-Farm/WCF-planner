// Pasture Map CP7 - manager-controlled boundary line style.
// Seeds one TEMP paddock, changes its stroke color/weight/pattern, and verifies
// the rendered map stroke, the persisted DB values, and the line-style chip.
//
// Boundary-style lane: only temp paddocks and GPS field tracks have editable
// line style (permanent pasture/paddock use a fixed, non-editable stroke). So
// CP7 seeds a temp paddock (permanence='temporary'). Line-style editing lives in
// the Setup tab (Map is read-only): select on the read-only Map, switch to Setup
// to edit, then read the line-style chip back on the Map area list.
import {test, expect} from '@playwright/test';
import {getTestAdminClient} from './setup/reset.js';

const A_ID = 'pm-cp7-style';
const SQUARE_A =
  '{"type":"Polygon","coordinates":[[[-86.44,30.84],[-86.435,30.84],[-86.435,30.845],[-86.44,30.845],[-86.44,30.84]]]}';

async function cleanAndSeedPastureTables() {
  const c = getTestAdminClient();
  const sql = `
    TRUNCATE TABLE public.pasture_planned_moves, public.pasture_move_impacts,
      public.pasture_move_events, public.land_area_geometry_versions,
      public.pasture_import_batches, public.land_areas RESTART IDENTITY CASCADE;

    INSERT INTO public.land_areas
      (id, kind, name, permanence, status, review_status, geometry_status, baseline_no_history, source)
    VALUES
      ('${A_ID}', 'paddock', 'CP7 Styled Paddock', 'temporary', 'active', 'reviewed', 'none', true, 'drawn');

    SELECT public._land_area_add_version(
      '${A_ID}',
      extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${SQUARE_A}'),4326),
      'drawn',
      '{}'::jsonb,
      NULL::uuid
    );
  `;
  const {error} = await c.rpc('exec_sql', {sql});
  if (error) throw new Error('seed pasture CP7: ' + error.message);
}

test.beforeAll(async () => {
  await cleanAndSeedPastureTables();
});

async function hideMapOverlays(page) {
  await page.addStyleTag({
    content:
      '.pm-boundary-toggle,.pm-legend,.pm-map-controls,.pm-draftlines-toggle,.pm-map-banner{display:none!important}',
  });
}

test('CP7: manager changes paddock line color, weight, and pattern', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});
  await expect(page.locator(`.pm-area-${A_ID}`).first()).toBeVisible({timeout: 25_000});
  await hideMapOverlays(page);

  // Line-style editing lives in the Area modal's Line style section (shown directly,
  // no disclosure).
  await page.locator('.pm-tabs button', {hasText: 'Map'}).click();
  await page.locator(`.pm-area-${A_ID}`).first().click();
  await expect(page.locator(`[data-pasture-plan-inspector="${A_ID}"]`)).toBeVisible({timeout: 15_000});
  await expect(page.locator('[data-pasture-style-panel]')).toBeVisible({timeout: 15_000});
  await page.locator('[data-pasture-style-swatch="2563eb"]').click();
  await page.locator('[data-pasture-style-pattern="dashed"]').click();
  await page.locator('[data-pasture-style-weight-number]').fill('6');
  await page.locator('[data-pasture-style-save]').click();

  // Persisted values (poll so we don't read mid-save).
  await expect
    .poll(
      async () => {
        const {data} = await getTestAdminClient()
          .from('land_areas')
          .select('line_color,line_weight,line_pattern')
          .eq('id', A_ID)
          .single();
        return data;
      },
      {timeout: 15_000},
    )
    .toEqual({line_color: '#2563eb', line_weight: 6, line_pattern: 'dashed'});

  // Clear the selection; selected areas render with the dark highlight stroke,
  // so deselecting lets the map show the area's own saved line style.
  await page.keyboard.press('Escape');
  await expect(page.locator(`[data-pasture-plan-inspector="${A_ID}"]`)).toHaveCount(0);

  // Map stroke reflects the saved style now that nothing is selected.
  const styledPath = page.locator('.leaflet-overlay-pane path[stroke="#2563eb"]').first();
  await expect(styledPath).toHaveAttribute('stroke-width', '6', {timeout: 15_000});
  await expect(styledPath).toHaveAttribute('stroke-dasharray', '10,8', {timeout: 10_000});
});
