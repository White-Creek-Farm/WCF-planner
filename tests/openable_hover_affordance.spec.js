import {test, expect} from './fixtures.js';

// ============================================================================
// Global openable affordance smoke (Build Queue: "CC - Global Openable Hover
// Affordance"). Static contract lives in
// tests/static/openable_hover_affordance_static.test.js; this spec proves the
// affordance actually renders in a browser on the two representative shapes:
//   - .hoverable-tile  → equipment fleet card (/fleet)
//   - .hoverable-row   → broiler batches <table> row (/broiler/batches)
// Wash color is the contract #f0fdf4 = rgb(240, 253, 244).
// ============================================================================

const WASH = 'rgb(240, 253, 244)';

function matrixTranslateY(transform) {
  if (!transform || transform === 'none') return 0;
  const match = transform.match(/^matrix\([^,]+,[^,]+,[^,]+,[^,]+,[^,]+,\s*([^)]+)\)$/);
  return match ? Number(match[1]) : NaN;
}

async function seedEquipment(supabaseAdmin, {id, name}) {
  const {error} = await supabaseAdmin.from('equipment').upsert(
    {
      id,
      slug: id,
      name,
      category: 'tractors',
      tracking_unit: 'hours',
      status: 'active',
      current_hours: null,
      current_km: null,
      warranty_expiration: null,
      service_intervals: [],
      attachment_checklists: [],
      every_fillup_items: [],
      notes: null,
    },
    {onConflict: 'id'},
  );
  if (error) throw new Error('seedEquipment(' + id + '): ' + error.message);
}

test('fleet tile: pointer cursor, hover wash + lift, keyboard focus + Enter opens the record', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  await seedEquipment(supabaseAdmin, {id: 'eq-a', name: 'Aaa Tractor'});
  await seedEquipment(supabaseAdmin, {id: 'eq-b', name: 'Bbb Tractor'});

  await page.goto('/fleet');
  const tile = page.locator('[data-equipment-tile]').first();
  await expect(tile).toBeVisible({timeout: 15_000});

  const resting = await tile.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {cursor: cs.cursor, transform: cs.transform};
  });
  expect(resting.cursor).toBe('pointer');
  expect(resting.transform).toBe('none');

  await tile.hover();
  await expect
    .poll(async () => tile.evaluate((el) => getComputedStyle(el).backgroundColor), {timeout: 3_000})
    .toBe(WASH);
  const hovered = await tile.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {transform: cs.transform, boxShadow: cs.boxShadow};
  });
  const hoverLift = matrixTranslateY(hovered.transform);
  expect(hoverLift).toBeLessThanOrEqual(-0.9);
  expect(hoverLift).toBeGreaterThanOrEqual(-1.1);
  expect(hovered.boxShadow).not.toBe('none');

  // Keyboard: Tab reaches the tile, :focus-visible draws the ring, Enter opens.
  await page.mouse.move(0, 0);
  let focused = false;
  for (let i = 0; i < 40 && !focused; i++) {
    await page.keyboard.press('Tab');
    focused = await page.evaluate(() => document.activeElement?.hasAttribute('data-equipment-tile'));
  }
  expect(focused, 'Tab never reached a fleet tile').toBe(true);
  const focusRing = await page.evaluate(() => {
    const cs = getComputedStyle(document.activeElement);
    return {outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth};
  });
  expect(focusRing.outlineStyle).toBe('solid');
  expect(focusRing.outlineWidth).toBe('2px');

  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/fleet\/eq-a$/, {timeout: 10_000});
});

test('broiler batches row: pointer cursor and hover wash on table cells, no transform', async ({
  page,
  broilerTimelineScenario,
}) => {
  await broilerTimelineScenario({});
  await page.goto('/broiler/batches');
  const row = page.locator('tr.hoverable-row').first();
  await expect(row).toBeVisible({timeout: 15_000});

  expect(await row.evaluate((el) => getComputedStyle(el).cursor)).toBe('pointer');

  await row.hover();
  const cell = row.locator('td').first();
  await expect
    .poll(async () => cell.evaluate((el) => getComputedStyle(el).backgroundColor), {timeout: 3_000})
    .toBe(WASH);
  // Rows wash only — the tile lift must not leak onto table rows.
  expect(await row.evaluate((el) => getComputedStyle(el).transform)).toBe('none');
});
