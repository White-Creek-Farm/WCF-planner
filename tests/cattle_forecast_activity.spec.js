import {test, expect} from './fixtures.js';

// ============================================================================
// Cattle forecast month hide/unhide → Custom editable-table Activity
// ============================================================================
// First "Custom editable-table Activity" lane: hiding a forecast month logs a
// status.changed event scoped to the cattle.forecast workflow entity (NOT the
// cattle.animal record), readable in the global Activity log (migration 076
// teaches _activity_can_read the cattle.forecast branch).
// ============================================================================

const FORECAST_PATH = '/cattle/forecast';

async function waitForForecastLoaded(page) {
  await expect(page.locator('[data-cattle-forecast-root]')).toBeVisible({timeout: 15_000});
  await expect(page.locator('[data-next-processor-panel]')).toBeVisible({timeout: 15_000});
}

test('forecast hide logs a cattle.forecast status.changed Activity event', async ({
  page,
  cattleForecastScenario,
  supabaseAdmin,
}) => {
  await page.goto(FORECAST_PATH);
  await waitForForecastLoaded(page);

  // Hide F-HIDE in its assigned month (toggle hook already exists in the UI).
  await expect(page.locator('[data-month-row="F-HIDE"]').first()).toBeVisible({timeout: 10_000});
  await page.locator('[data-toggle-hide="F-HIDE"]').click();

  // The hide/unhide table write is the source of truth — confirm it landed.
  await expect
    .poll(async () => {
      const r = await supabaseAdmin.from('cattle_forecast_hidden').select('cattle_id').eq('cattle_id', 'F-HIDE');
      return r.data?.length || 0;
    })
    .toBe(1);

  // Best-effort audit fires after the write: a cattle.forecast status.changed
  // event scoped to the forecast workflow (entity_id 'cattle-forecast'), with
  // the cow carried in the payload — NOT a cattle.animal event.
  await expect
    .poll(
      async () => {
        const r = await supabaseAdmin.from('activity_events').select('payload').eq('entity_type', 'cattle.forecast');
        return (r.data || []).some((e) => e.payload && e.payload.cattle_id === 'F-HIDE');
      },
      {timeout: 10_000},
    )
    .toBe(true);

  // Re-fetch the resolved event for field assertions.
  const {data: rows} = await supabaseAdmin
    .from('activity_events')
    .select('entity_id,event_type,body,payload')
    .eq('entity_type', 'cattle.forecast');
  const ev = (rows || []).find((e) => e.payload && e.payload.cattle_id === 'F-HIDE');
  expect(ev.entity_id).toBe('cattle-forecast');
  expect(ev.event_type).toBe('status.changed');
  expect(ev.body).toMatch(/Forecast month .* changed visible → hidden/);
  expect(ev.payload.field).toBe('forecast_month_visibility');

  // No cattle.animal event was created for this forecast table change.
  const {data: animalEvents} = await supabaseAdmin
    .from('activity_events')
    .select('id')
    .eq('entity_type', 'cattle.animal')
    .eq('entity_id', 'F-HIDE');
  expect(animalEvents || []).toHaveLength(0);

  // And it surfaces in the global Activity log under "Cattle Forecast".
  await page.goto('/activity');
  const firstRow = page.locator('[data-activity-log-row]').first();
  for (let i = 0; i < 6; i++) {
    if (await firstRow.isVisible().catch(() => false)) break;
    await page.waitForTimeout(1000);
    await page.reload();
  }
  await expect(firstRow).toBeVisible({timeout: 15_000});
  await expect(page.getByText(/Forecast month .* changed visible → hidden/)).toBeVisible({timeout: 10_000});
});
