import {test, expect} from './fixtures.js';

// ============================================================================
// Global openable affordance smoke (Build Queue: "CC - Global Openable Hover
// Affordance"). Static contract lives in
// tests/static/openable_hover_affordance_static.test.js; this spec proves the
// affordance actually renders in a browser on the two representative shapes:
//   - .hoverable-tile  → equipment fleet card (/fleet): lifts on hover (Home
//     parity .lift) with a soft shadow, NO background wash.
//   - .hoverable-row   → broiler batches <table> row (/broiler/batches):
//     neutral --row-hover wash on its cells, no lift.
// The row wash follows the --row-hover token, resolved to rgb at runtime rather
// than a hardcoded literal (the parity rollout retired the green #f0fdf4 wash).
// ============================================================================

function matrixTranslateY(transform) {
  if (!transform || transform === 'none') return 0;
  const match = transform.match(/^matrix\([^,]+,[^,]+,[^,]+,[^,]+,[^,]+,\s*([^)]+)\)$/);
  return match ? Number(match[1]) : NaN;
}

// Resolve a CSS custom property to the rgb() string the browser computes for it,
// so wash assertions track the token instead of a brittle hardcoded color.
async function resolveVarRgb(page, varName) {
  return page.evaluate((name) => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = `var(${name})`;
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return c;
  }, varName);
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

  const restingBg = await tile.evaluate((el) => getComputedStyle(el).backgroundColor);
  await tile.hover();
  // Parity .lift: the tile rises ~2px and gains a shadow; it must NOT wash.
  await expect
    .poll(async () => matrixTranslateY(await tile.evaluate((el) => getComputedStyle(el).transform)), {timeout: 3_000})
    .toBeLessThanOrEqual(-1.9);
  const hovered = await tile.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {transform: cs.transform, boxShadow: cs.boxShadow, backgroundColor: cs.backgroundColor};
  });
  expect(matrixTranslateY(hovered.transform)).toBeGreaterThanOrEqual(-2.1);
  expect(hovered.boxShadow).not.toBe('none');
  // No wash: hovering a tile must not repaint its background.
  expect(hovered.backgroundColor).toBe(restingBg);

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

test('broiler batches row: pointer cursor, hover wash on cells, no transform, Enter opens the record', async ({
  page,
  broilerTimelineScenario,
}) => {
  await broilerTimelineScenario({});
  await page.goto('/broiler/batches');
  const row = page.locator('tr.hoverable-row').first();
  await expect(row).toBeVisible({timeout: 15_000});

  expect(await row.evaluate((el) => getComputedStyle(el).cursor)).toBe('pointer');

  const expectedWash = await resolveVarRgb(page, '--row-hover');
  await row.hover();
  const cell = row.locator('td').first();
  await expect
    .poll(async () => cell.evaluate((el) => getComputedStyle(el).backgroundColor), {timeout: 3_000})
    .toBe(expectedWash);
  // Rows wash only — the tile lift must not leak onto table rows.
  expect(await row.evaluate((el) => getComputedStyle(el).transform)).toBe('none');

  // Keyboard parity (rollout lane): the row is a focusable button-role
  // openable, and Enter activates the same navigation as click.
  expect(await row.getAttribute('role')).toBe('button');
  expect(await row.getAttribute('tabindex')).toBe('0');
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/broiler\/batches\/.+/, {timeout: 10_000});
});

// ============================================================================
// Home Weather (rollout lane): the collapsed weather card is a real <button>
// carrying the approved `card weather-card lift` home treatment — design lift
// on hover (translateY(-2px) + shadow) — and opens the weather modal, whose
// Refresh/close controls stay plain buttons. The forecast endpoint is mocked
// so the card renders deterministically.
// ============================================================================

const FORECAST_FIXTURE = {
  current: {temp: 72, weatherCode: 1101},
  today: {high: 88, low: 69, precipProb: 40},
  rainSummary: 'Rain likely this afternoon',
  freezeWarning: null,
  dailySource: 'open-meteo',
  daily: Array.from({length: 10}, (_, i) => ({
    date: `2026-06-${String(11 + i).padStart(2, '0')}`,
    tempMax: 88,
    tempMin: 69,
    precipProbMax: 40,
    weatherCodeMax: 1101,
  })),
  hourly: [],
  location: {lat: 30.84, lon: -86.43, label: 'Farm'},
};

test('home weather card: button with card/lift treatment, hover lift, click opens modal', async ({page, resetDb}) => {
  await resetDb();
  await page.route('**/.netlify/functions/weather-forecast*', (route) =>
    route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(FORECAST_FIXTURE)}),
  );
  await page.goto('/');

  const card = page.locator('[data-weather-card="collapsed"]');
  await expect(card).toBeVisible({timeout: 15_000});

  // Approved home treatment: a real <button> (native keyboard) with the
  // design's card + weather-card + lift classes.
  expect(await card.evaluate((el) => el.tagName)).toBe('BUTTON');
  expect(await card.evaluate((el) => el.className)).toContain('card');
  expect(await card.evaluate((el) => el.className)).toContain('weather-card');
  expect(await card.evaluate((el) => el.className)).toContain('lift');
  expect(await card.evaluate((el) => getComputedStyle(el).cursor)).toBe('pointer');
  expect(await card.evaluate((el) => getComputedStyle(el).transform)).toBe('none');

  // Design lift on hover: translateY(-2px) + hover shadow (paint-only).
  await card.hover();
  await expect
    .poll(async () => matrixTranslateY(await card.evaluate((el) => getComputedStyle(el).transform)), {timeout: 3_000})
    .toBeLessThanOrEqual(-1.9);
  expect(await card.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none');

  // Click opens the expanded weather modal; its controls remain buttons.
  await card.click();
  const modal = page.locator('[data-weather-card="expanded"]');
  await expect(modal).toBeVisible({timeout: 5_000});
  const refresh = modal.getByRole('button', {name: 'Refresh'});
  await expect(refresh).toBeVisible();
  const close = modal.getByRole('button', {name: '×'});
  await close.click();
  await expect(modal).not.toBeVisible();
});
