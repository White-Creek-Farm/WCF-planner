// Pasture Map CP6 - mobile field GPS tracks. Uses a mocked browser geolocation
// provider so the UI path is deterministic: Track -> Start -> Stop -> Save.
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
  await expect(page.locator('.pm-title')).toHaveText('Pasture Map');
  await page.locator('[data-mode="track"]').click();
  await expect(page.locator('[data-pasture-track-panel]')).toBeVisible();
  await page.locator('[data-pasture-track-start]').click();
  await expect(page.locator('[data-pasture-track-stats]')).toContainText('2 pts', {timeout: 10_000});
  await page.locator('[data-pasture-track-stop]').click();
  await page.locator('[data-pasture-track-name]').fill('Mobile Track Test');
  await page.locator('[data-pasture-track-save]').click();

  const row = page.locator('.pm-item', {hasText: 'Mobile Track Test'}).first();
  await expect(row).toBeVisible({timeout: 15_000});
  await expect(row.locator('.pm-chip-outline_candidate')).toBeVisible();
  await expect(row.locator('[data-pasture-line-style]')).toContainText('5 px Dashed');

  const {data, error} = await getTestAdminClient()
    .from('land_areas')
    .select('line_color,line_weight,line_pattern')
    .eq('name', 'Mobile Track Test')
    .single();
  expect(error).toBeFalsy();
  expect(data).toEqual({line_color: '#ffffff', line_weight: 5, line_pattern: 'dashed'});
});
