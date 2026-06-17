// Pasture Map CP7 - manager-controlled boundary line style.
// Seeds one paddock, changes its stroke color/weight/pattern through the selected-area
// panel, and verifies both the rendered map stroke and persisted DB values.
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
      (id, kind, name, status, review_status, geometry_status, baseline_no_history, source)
    VALUES
      ('${A_ID}', 'paddock', 'CP7 Styled Paddock', 'active', 'reviewed', 'none', true, 'drawn');

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

test('CP7: manager changes paddock line color, weight, and pattern', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});

  const row = page.locator(`[data-pasture-area="${A_ID}"]`).first();
  await expect(row).toContainText('CP7 Styled Paddock', {timeout: 25_000});
  await row.locator(`[data-pasture-area-select="${A_ID}"]`).click();

  await expect(page.locator('[data-pasture-style-panel]')).toBeVisible();
  await page.locator('[data-pasture-style-swatch="2563eb"]').click();
  await page.locator('[data-pasture-style-pattern="dashed"]').click();
  await page.locator('[data-pasture-style-weight-number]').fill('6');
  await page.locator('[data-pasture-style-save]').click();

  await expect(row.locator('[data-pasture-line-style]')).toContainText('6 px Dashed', {timeout: 15_000});
  const styledPath = page.locator('.leaflet-overlay-pane path[stroke="#2563eb"]').first();
  await expect(styledPath).toHaveAttribute('stroke-width', '6', {timeout: 10_000});
  await expect(styledPath).toHaveAttribute('stroke-dasharray', '10,8', {timeout: 10_000});

  const {data, error} = await getTestAdminClient()
    .from('land_areas')
    .select('line_color,line_weight,line_pattern')
    .eq('id', A_ID)
    .single();
  expect(error).toBeFalsy();
  expect(data).toEqual({line_color: '#2563eb', line_weight: 6, line_pattern: 'dashed'});
});
