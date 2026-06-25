// Pasture Map CP6 - mobile field GPS tracks. Uses a mocked browser geolocation
// provider so the UI path is deterministic: Setup -> GPS Boundary -> Stop -> Save.
//
// Updated for the planner-group redesign: the GPS boundary tool lives in the
// Setup tab; clicking it (data-mode="track") starts recording immediately. The
// saved 2-point trace stays an outline candidate and surfaces on the read-only
// Map area list with its default field-track line style.
import {test, expect} from '@playwright/test';
import {getTestAdminClient} from './setup/reset.js';

async function cleanPastureTables() {
  const c = getTestAdminClient();
  const {error} = await c.rpc('exec_sql', {
    sql: 'TRUNCATE TABLE public.pasture_planned_moves, public.pasture_move_impacts, public.pasture_move_events, public.land_area_geometry_versions, public.pasture_import_batches, public.land_areas RESTART IDENTITY CASCADE;',
  });
  if (error) throw new Error('clean pasture tables: ' + error.message);
}

test.beforeAll(async () => {
  await cleanPastureTables();
});

test('CP6: mobile GPS track saves as an outline candidate', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.addInitScript(() => {
    const points = [
      {coords: {longitude: -86.44, latitude: 30.84, accuracy: 4}},
      {coords: {longitude: -86.439, latitude: 30.841, accuracy: 5}},
    ];
    let nextId = 1;
    const timers = new Map();
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        watchPosition(success) {
          const id = nextId++;
          timers.set(
            id,
            points.map((p, i) => window.setTimeout(() => success(p), 80 + i * 120)),
          );
          return id;
        },
        clearWatch(id) {
          for (const t of timers.get(id) || []) window.clearTimeout(t);
          timers.delete(id);
        },
      },
    });
  });

  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});

  // GPS boundary tools live in the Plan tab's collapsible Boundary tools card now.
  await page.locator('.pm-tabs button', {hasText: 'Map'}).click();
  await page.locator('[data-pasture-boundary-tools-toggle]').click();
  await page.locator('[data-mode="track"]').click();
  await expect(page.locator('[data-pasture-track-panel]')).toBeVisible();
  await expect(page.locator('[data-pasture-track-stats]')).toContainText('2 pts', {timeout: 10_000});
  await page.locator('[data-pasture-track-stop]').click();
  await page.locator('[data-pasture-track-name]').fill('Mobile Track Test');
  await page.locator('[data-pasture-track-save]').click();

  // Saving selects the new track -> the Plan Area inspector opens; clear it.
  await expect(page.locator('[data-pasture-plan-inspector]')).toBeVisible({timeout: 15_000});
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-pasture-plan-inspector]')).toHaveCount(0);

  // The 2-point trace is a draft line: it surfaces in the Tracks / Lines section
  // (Plan), not the Map grazing-area list.
  const row = page.locator('[data-pasture-track-line]', {hasText: 'Mobile Track Test'}).first();
  await expect(row).toBeVisible({timeout: 15_000});
  await expect(row.locator('.pm-chip-outline_candidate')).toBeVisible();

  const {data, error} = await getTestAdminClient()
    .from('land_areas')
    .select('line_color,line_weight,line_pattern')
    .eq('name', 'Mobile Track Test')
    .single();
  expect(error).toBeFalsy();
  expect(data).toEqual({line_color: '#ffffff', line_weight: 5, line_pattern: 'dashed'});
});
